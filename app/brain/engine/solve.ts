import { priorityWeight, scheduleCost } from "./cost"
import { resolveConstants } from "./constants"
import { applyBackdating } from "./lifecycle"
import { evaluateCandidate } from "./placement"
import { placeGreedy } from "./greedy"
import { placeFixedSet, placeHardSet } from "./hard-set"
import {
  expandDailyOccurrences,
  isEligibleOnDay,
  resolveWindows,
  type ResolvedActivity,
} from "./resolve"
import { isDependent, placeSequenceChain, sequenceRuleOf } from "./sequence"
import { weekdayOf } from "./time"
import { validateActivity, validateCatalog } from "./validation"
import type {
  Activity,
  AdhocPayload,
  CostConstants,
  Day,
  Diagnostic,
  Interval,
  Placement,
  Relaxation,
  RejectionCode,
  RejectionError,
  Rule,
  SkipReason,
  SolveInput,
  SolveResult,
  Timeline,
  TimelineActivity,
  TimelineStatus,
} from "./types"

/** Identifies which real activity and which frame day a placement target
 * belongs to (SPEC-v2.1 §15 row 2). Ghosted activities carry a day-scoped
 * `id`; this is how `freshInstance`/`chunkedInstances` recover the real
 * `activityId` and the correct occurrence date from one, and how
 * `runPipeline` derives each ghost's own day-bounded free-interval search
 * (`isGhost: true`). Activities absent from the meta map (the default,
 * everywhere outside multi-day GENERATE_DAY) fall back to
 * `{ sourceId: activity.id, day: frame.days[0], isGhost: false }` — exactly
 * today's single-instance-per-frame behavior, unbounded by day. */
type OccurrenceMetaOf = (activity: Activity) => {
  sourceId: string
  day: Day
  isGhost: boolean
}

function hasFixed(activity: Activity): boolean {
  return activity.rules.some((r) => r.type === "fixed")
}

// SPEC-v2.md Section 5.1: isHardConstrained = hasFixedRule || requiredCount > 0.
function isRequired(activity: Activity): boolean {
  return activity.requiredCount > 0
}

function relaxationsFor(
  resolved: ResolvedActivity,
  placement: Placement | null
): Relaxation[] {
  if (!placement) return []
  const relaxations: Relaxation[] = []

  const scheduledMinutes = placement.end - placement.start
  const shrunkBy = resolved.activity.durationMinutes - scheduledMinutes
  if (shrunkBy > 0) relaxations.push({ type: "shrink", minutes: shrunkBy })

  const verdict = evaluateCandidate(resolved, placement.start, placement.end)
  if (verdict.driftMinutes > 0) {
    relaxations.push({ type: "drift", minutes: verdict.driftMinutes })
  }

  return relaxations
}

function freshInstance(
  activity: Activity,
  sourceId: string,
  day: Day,
  placement: Placement | null,
  skipReason: SkipReason | null,
  relaxations: readonly Relaxation[]
): TimelineActivity {
  const occurrenceId = `${sourceId}@${day.date}#1`
  return {
    id: occurrenceId,
    activityId: sourceId,
    occurrenceId,
    occurrenceIndex: 1,
    bucketKey: day.date,
    date: day.date,
    name: activity.name,
    durationMinutes: activity.durationMinutes,
    priorityRank: activity.priorityRank,
    requiredCount: activity.requiredCount,
    rules: activity.rules,
    state: placement ? "PLANNED" : "SKIPPED",
    completedSource: null,
    plannedStart: placement ? placement.start : null,
    plannedEnd: placement ? placement.end : null,
    actualStart: null,
    actualEnd: null,
    scheduledMinutes: placement ? placement.end - placement.start : 0,
    blockIndex: 1,
    blockCount: 1,
    chunkGroupId: null,
    hostInstanceId: placement?.nestedIn ?? null,
    isAdhoc: false,
    spanningFromPreviousDay: false,
    relaxations,
    locked: false,
    skipReason,
  }
}

/**
 * A chunked activity's plan (SPEC.md Section 8.6 step 5) becomes several
 * top-level instances sharing one `chunkGroupId`. The whole plan's shrink
 * and chunk-count relaxations are recorded once, on the first chunk, so
 * they aren't double-counted when read back out of the instance list.
 */
function chunkedInstances(
  activity: Activity,
  sourceId: string,
  day: Day,
  resolved: ResolvedActivity,
  chunkPlacements: readonly Placement[]
): TimelineActivity[] {
  const sorted = [...chunkPlacements].sort((a, b) => a.start - b.start)
  const totalScheduled = sorted.reduce((sum, c) => sum + (c.end - c.start), 0)
  const shrunkBy = activity.durationMinutes - totalScheduled

  const occurrenceId = `${sourceId}@${day.date}#1`

  return sorted.map((placement, index) => {
    const relaxations: Relaxation[] = []
    if (index === 0) {
      if (shrunkBy > 0) relaxations.push({ type: "shrink", minutes: shrunkBy })
      if (sorted.length > 1) {
        relaxations.push({ type: "chunk", minutes: sorted.length - 1 })
      }
    }
    const verdict = evaluateCandidate(resolved, placement.start, placement.end)
    if (verdict.driftMinutes > 0) {
      relaxations.push({ type: "drift", minutes: verdict.driftMinutes })
    }

    return {
      id: `${occurrenceId}~${index + 1}`,
      activityId: sourceId,
      occurrenceId,
      occurrenceIndex: 1,
      bucketKey: day.date,
      date: day.date,
      name: activity.name,
      durationMinutes: activity.durationMinutes,
      priorityRank: activity.priorityRank,
      requiredCount: activity.requiredCount,
      rules: activity.rules,
      state: "PLANNED",
      completedSource: null,
      plannedStart: placement.start,
      plannedEnd: placement.end,
      actualStart: null,
      actualEnd: null,
      scheduledMinutes: placement.end - placement.start,
      blockIndex: index + 1,
      blockCount: sorted.length,
      chunkGroupId: occurrenceId,
      hostInstanceId: placement.nestedIn,
      isAdhoc: false,
      spanningFromPreviousDay: false,
      relaxations,
      locked: false,
      skipReason: null,
    }
  })
}

interface PipelineOutcome {
  readonly instances: TimelineActivity[]
  readonly diagnostics: Diagnostic[]
  readonly status: TimelineStatus
}

/**
 * The Phase 1 / Phase 2 / Phase 2.5 solve, parameterized over exactly which
 * activities are still up for solving and what's already occupying the day.
 * `activitiesToSolve` excludes anything TICK has anchored (SPEC.md Section
 * 9.2) — for `GENERATE_DAY` that's the full catalogue and `baseOccupied` is
 * empty, reproducing the original single-pass behaviour exactly.
 */
function runPipeline(
  input: SolveInput,
  constants: CostConstants,
  activitiesToSolve: readonly Activity[],
  baseOccupied: readonly Interval[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  freezeBoundary: number = input.now,
  fullCatalog: readonly Activity[] = activitiesToSolve,
  anchorPlacements: ReadonlyMap<string, Placement> = new Map(),
  occurrenceMetaOf: OccurrenceMetaOf = (activity) => ({
    sourceId: activity.id,
    day: input.dayFrame.days[0],
    isGhost: false,
  })
): PipelineOutcome {
  const grid = constants.GRID
  const nodeLimit = constants.HARD_SET_NODE_LIMIT
  const lengthMinutes = input.dayFrame.lengthMinutes

  // SPEC-v2.1 §15 row 2: bounds a ghost's free-interval search to its own
  // day (HardSetContext/GreedyContext.dayBoundOf's docstring). Undefined for
  // every non-ghost activity, which is a no-op at both call sites.
  const dayBoundOf = (activity: Activity): Interval | undefined => {
    const meta = occurrenceMetaOf(activity)
    return meta.isGhost
      ? { start: meta.day.startOffset, end: meta.day.startOffset + meta.day.lengthMinutes }
      : undefined
  }

  // Sequence dependents (SPEC.md Section 5.6) are placed adjacent to their
  // host out of priority order, so they sit outside the normal hard-set /
  // discretionary partitioning below. A dependent that is itself Fixed keeps
  // its declared time and is treated as an ordinary host instead — there is
  // nothing left for the sequence relationship to solve for it.
  const sequenceDependents = activitiesToSolve.filter(
    (a) => isDependent(a) && !hasFixed(a)
  )
  const hostPool = activitiesToSolve.filter(
    (a) => !sequenceDependents.includes(a)
  )

  // Phase 1a: FixedRule activities, placed at their declared times.
  const fixedSet = hostPool.filter(hasFixed)
  const fixedOutcome = placeFixedSet(
    fixedSet,
    input.dayFrame,
    freezeBoundary,
    baseOccupied
  )
  const occupiedAfterFixed: Interval[] = [
    ...baseOccupied,
    ...[...fixedOutcome.placements.values()].map((p) => ({
      start: p.start,
      end: p.end,
    })),
  ]

  // Phase 1b: the remaining hard set — MandatoryRule without a FixedRule —
  // most-constrained first, with bounded backtracking.
  const mandatorySet = hostPool.filter((a) => isRequired(a) && !hasFixed(a))
  const hardOutcome = placeHardSet(mandatorySet, occupiedAfterFixed, {
    freezeBoundary,
    grid,
    lengthMinutes,
    nodeLimit,
    constants,
    resolve,
    weight,
    dayFrame: input.dayFrame,
    dayBoundOf,
  })
  const occupiedAfterHardSet: Interval[] = [
    ...occupiedAfterFixed,
    ...[...hardOutcome.placements.values()].map((p) => ({
      start: p.start,
      end: p.end,
    })),
  ]

  // Phase 2: everything else, greedily, by ascending priority rank.
  const hardSetIds = new Set([
    ...fixedSet.map((a) => a.id),
    ...mandatorySet.map((a) => a.id),
  ])
  const discretionary = hostPool.filter((a) => !hardSetIds.has(a.id))
  const initialHostPlacements = new Map<string, Placement>([
    ...anchorPlacements,
    ...fixedOutcome.placements,
    ...hardOutcome.placements,
  ])
  const greedyOutcome = placeGreedy(discretionary, occupiedAfterHardSet, {
    freezeBoundary,
    grid,
    lengthMinutes,
    constants,
    resolve,
    weight,
    dayFrame: input.dayFrame,
    // The full catalogue, not just hostPool, so a guest can still nest into
    // a host that's already anchored (SPEC.md Section 9.6's canonical case:
    // editing an ACTIVE Work's OverlapRule to admit a new guest) even though
    // that host isn't itself up for re-solving this round.
    allActivities: fullCatalog,
    initialHostPlacements,
    dayBoundOf,
  })
  const chunksFlat: Interval[] = [...greedyOutcome.chunks.values()].flatMap(
    (chunks) => chunks.map((c) => ({ start: c.start, end: c.end }))
  )
  const occupiedAfterGreedy: Interval[] = [
    ...occupiedAfterHardSet,
    ...[...greedyOutcome.placements.values()].map((p) => ({
      start: p.start,
      end: p.end,
    })),
    ...chunksFlat,
  ]

  // Phase 2.5: sequence dependents, adjacent to their already-placed host.
  // A chunked host binds dependents to its outer span (SPEC.md Section 5.6
  // more precisely binds pre/post to the first/last chunk individually —
  // deferred until a worked example exercises Sequence+Shrink together).
  const hostResolutions = new Map<string, Placement | "SKIPPED">()
  for (const activity of hostPool) {
    const chunksPlaced = greedyOutcome.chunks.get(activity.id)
    if (chunksPlaced) {
      const starts = chunksPlaced.map((c) => c.start)
      const ends = chunksPlaced.map((c) => c.end)
      hostResolutions.set(activity.id, {
        start: Math.min(...starts),
        end: Math.max(...ends),
        nestedIn: null,
      })
      continue
    }
    const placement =
      fixedOutcome.placements.get(activity.id) ??
      hardOutcome.placements.get(activity.id) ??
      greedyOutcome.placements.get(activity.id) ??
      null
    hostResolutions.set(activity.id, placement ?? "SKIPPED")
  }
  const sequenceOutcome = placeSequenceChain(
    sequenceDependents,
    hostResolutions,
    occupiedAfterGreedy,
    { freezeBoundary, lengthMinutes, grid, resolve }
  )

  const instances = activitiesToSolve.flatMap((activity) => {
    const { sourceId, day } = occurrenceMetaOf(activity)
    const chunksPlaced = greedyOutcome.chunks.get(activity.id)
    if (chunksPlaced) {
      return chunkedInstances(
        activity,
        sourceId,
        day,
        resolve(activity),
        chunksPlaced
      )
    }

    const placement =
      fixedOutcome.placements.get(activity.id) ??
      hardOutcome.placements.get(activity.id) ??
      greedyOutcome.placements.get(activity.id) ??
      sequenceOutcome.placements.get(activity.id) ??
      null
    const skipReason =
      fixedOutcome.skipped.get(activity.id) ??
      hardOutcome.skipped.get(activity.id) ??
      greedyOutcome.skipped.get(activity.id) ??
      sequenceOutcome.skipped.get(activity.id) ??
      null
    const sequenceRelaxations = sequenceOutcome.relaxations.get(activity.id)
    const relaxations = sequenceRelaxations
      ? [
          ...sequenceRelaxations,
          ...relaxationsFor(resolve(activity), placement),
        ]
      : relaxationsFor(resolve(activity), placement)
    return [
      freshInstance(
        activity,
        sourceId,
        day,
        placement,
        skipReason,
        relaxations
      ),
    ]
  })

  const { diagnostics: scanDiagnostics, status: scanStatus } =
    buildDiagnostics(instances)
  const diagnostics: Diagnostic[] = [
    ...fixedOutcome.diagnostics,
    ...scanDiagnostics,
  ]
  const status: TimelineStatus =
    fixedOutcome.diagnostics.length > 0 ? "DEGRADED" : scanStatus

  return { instances, diagnostics, status }
}

/**
 * Per-instance advisory diagnostics (SPEC.md Section 8.8) — a pure function
 * of the instance list, so it can be reused both for a freshly solved batch
 * and for an unchanged TICK echo.
 */
function buildDiagnostics(instances: readonly TimelineActivity[]): {
  diagnostics: Diagnostic[]
  status: TimelineStatus
} {
  const diagnostics: Diagnostic[] = []
  let status: TimelineStatus = "OK"

  for (const inst of instances) {
    if (
      inst.state === "SKIPPED" &&
      inst.skipReason === "INFEASIBLE_HARD_CONSTRAINT"
    ) {
      status = "DEGRADED"
      diagnostics.push({
        severity: "blocking",
        code: "INFEASIBLE_HARD_CONSTRAINT",
        instanceIds: [inst.id],
        message: `"${inst.name}" is mandatory but could not be placed today.`,
        suggestedFix:
          "Free up time elsewhere, widen its window, or add a ShrinkRule.",
      })
    }

    if (inst.blockIndex !== 1) continue // avoid double-reporting a chunked plan

    const shrink = inst.relaxations.find((r) => r.type === "shrink")
    if (shrink && inst.blockCount === 1) {
      diagnostics.push({
        severity: "info",
        code: "SHRUNK",
        instanceIds: [inst.id],
        message: `"${inst.name}" shortened from ${inst.durationMinutes} to ${inst.scheduledMinutes} minutes.`,
        suggestedFix: null,
      })
    }

    const chunked = inst.relaxations.find((r) => r.type === "chunk")
    if (chunked) {
      diagnostics.push({
        severity: "info",
        code: "CHUNKED",
        instanceIds: [inst.id],
        message: `"${inst.name}" was split into ${inst.blockCount} blocks.`,
        suggestedFix: null,
      })
    }
  }

  return { diagnostics, status }
}

interface AnchorSet {
  readonly anchors: TimelineActivity[]
  readonly anchorActivityIds: Set<string>
  readonly baseOccupied: Interval[]
  /** Anchor placements keyed by activityId, for guest-nesting lookups. */
  readonly anchorPlacements: ReadonlyMap<string, Placement>
}

/**
 * SPEC-v2.md §7.1: every event reduces to a plan (produced by per-event
 * code) and a shared executor (`runEvent`). The plan carries only what
 * differs across events; the executor is written once.
 */
interface EventPlan {
  /** Precondition failure — short-circuits before the pipeline runs. */
  readonly rejection: RejectionError | null
  /** `existing` with the event's mutation applied. */
  readonly workingExisting: readonly TimelineActivity[]
  /** Freeze boundary for the re-solve — ordinarily `now`; `at` for FINISH_EARLY. */
  readonly freezeBoundary: number
  /** Extra activities beyond today's catalogue (ADD_ADHOC's pseudo-activity). */
  readonly extraActivities: readonly Activity[]
  /** Whether to run `checkEventRejection` on the speculative result. */
  readonly checkRejection: boolean
  /** Extra instances injected between anchors and solved (SKIP's locked instance). */
  readonly extraInstances: readonly TimelineActivity[]
  /** Override catalogue for this solve (EDIT_INSTANCE_RULES substitutes rules). */
  readonly catalogOverride: readonly Activity[] | null
  /** Override weight function (ADD_ADHOC's totalRanked+1 denominator). */
  readonly weightOverride: ((activity: Activity) => number) | null
  /** Post-pipeline instance transform (ADD_ADHOC's `activityId: null` tagging). */
  readonly instanceTransform:
    | ((instances: readonly TimelineActivity[]) => TimelineActivity[])
    | null
  /** totalRanked override for cost recomputation (ADD_ADHOC). */
  readonly totalRankedOverride: number | null
  /** TICK's short-circuit: return the input timeline unchanged. */
  readonly shortCircuitResult: SolveResult | null
  /** Activity ids excluded from re-solving (SKIP's target). */
  readonly excludeActivityIds: ReadonlySet<string> | null
}

/**
 * An anchor is an existing instance the next solve must leave untouched:
 * either it's already consumed real time (ACTIVE/COMPLETED/CARRIED_IN) or a
 * prior event pinned it explicitly (`locked`, e.g. a user SKIP — SPEC.md
 * Section 9.7). Chunked activities (chunkGroupId set) never anchor here —
 * see the note on `solveTick`. A locked instance without planned times
 * (a SKIPPED one) contributes no occupied interval, just an excluded
 * activity id.
 */
function extractAnchors(existing: readonly TimelineActivity[]): AnchorSet {
  const ANCHOR_STATES = new Set(["ACTIVE", "COMPLETED", "CARRIED_IN"])
  const anchors = existing.filter(
    (inst) =>
      inst.chunkGroupId === null &&
      (inst.locked || ANCHOR_STATES.has(inst.state))
  )
  // An ad-hoc anchor has activityId: null (SPEC.md Section 9.5), so its key
  // for "already spoken for, exclude from re-solving" purposes is its own
  // instance id instead.
  const anchorActivityIds = new Set(
    anchors.map((a) => a.activityId ?? a.id)
  )
  const placedAnchors = anchors.filter(
    (a) => a.plannedStart !== null && a.plannedEnd !== null
  )
  const baseOccupied: Interval[] = placedAnchors
    .filter((a) => !a.hostInstanceId)
    .map((a) => ({
      start: a.actualStart ?? (a.plannedStart as number),
      end: a.actualEnd ?? (a.plannedEnd as number),
    }))
  const anchorPlacements = new Map<string, Placement>(
    placedAnchors.map((a) => [
      a.activityId ?? a.id,
      {
        start: a.plannedStart as number,
        end: a.plannedEnd as number,
        nestedIn: a.hostInstanceId,
      },
    ])
  )
  return { anchors, anchorActivityIds, baseOccupied, anchorPlacements }
}

function rejectionResult(
  input: SolveInput,
  code: RejectionCode,
  message: string,
  conflictingInstanceIds: readonly string[],
  constants: CostConstants,
  totalRanked: number,
  bestEffortTimeline: Timeline | null = null
): SolveResult {
  const { diagnostics, status } = buildDiagnostics(input.existing)
  const cost = scheduleCost(
    input.existing,
    input.dayFrame.lengthMinutes,
    totalRanked,
    constants
  )
  const timeline: Timeline = {
    dayFrame: input.dayFrame,
    revision: input.revision ?? 0,
    instances: [...input.existing],
    diagnostics,
    cost,
    status,
    solvedAtOffset: input.now,
    finalised: false,
    carryIn: [],
  }
  const rejection: RejectionError = {
    code,
    message,
    conflictingInstanceIds,
    diagnostics: bestEffortTimeline?.diagnostics ?? diagnostics,
    bestEffortTimeline,
  }
  return {
    status: "REJECTED",
    timeline,
    rejection,
    diagnostics,
    cost,
    trace: null,
  }
}

/**
 * Re-solving an ad-hoc through the ordinary pipeline (see
 * `adhocActivitiesFrom`) produces an instance with `activityId` set to its
 * pseudo-activity id, since `freshInstance` doesn't know it's ad-hoc. This
 * restores the `activityId: null, isAdhoc: true` tagging SPEC.md Section
 * 9.5 requires, for every instance whose group key is a known ad-hoc id.
 */
function tagAdhocInstances(
  instances: readonly TimelineActivity[],
  adhocIds: ReadonlySet<string>
): TimelineActivity[] {
  if (adhocIds.size === 0) return [...instances]
  return instances.map((inst) =>
    adhocIds.has(groupKeyOf(inst))
      ? { ...inst, activityId: null, isAdhoc: true }
      : inst
  )
}

function toResult(
  input: SolveInput,
  rawInstances: readonly TimelineActivity[],
  diagnostics: readonly Diagnostic[],
  status: TimelineStatus,
  constants: CostConstants,
  totalRanked: number,
  revision: number
): SolveResult {
  const adhocIds = new Set(
    input.existing.filter((i) => i.isAdhoc).map((i) => groupKeyOf(i))
  )
  const instances = tagAdhocInstances(rawInstances, adhocIds)
  const cost = scheduleCost(
    instances,
    input.dayFrame.lengthMinutes,
    totalRanked,
    constants
  )
  const timeline: Timeline = {
    dayFrame: input.dayFrame,
    revision,
    instances: [...instances],
    diagnostics: [...diagnostics],
    cost,
    status,
    solvedAtOffset: input.now,
    finalised: false,
    carryIn: [],
  }
  return {
    status,
    timeline,
    rejection: null,
    diagnostics: timeline.diagnostics,
    cost,
    trace: null,
  }
}

/**
 * SPEC-v2.md §7.1: the shared executor. Every event's plan runs through
 * this one function — extractAnchors, filter catalogue, runPipeline,
 * assemble, optionally checkEventRejection — in exactly the order
 * ALGORITHM.md §14 lists as steps 4–7.
 */
function runEvent(
  input: SolveInput,
  plan: EventPlan,
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number,
  occurrenceMetaOf?: OccurrenceMetaOf
): SolveResult {
  if (plan.shortCircuitResult) return plan.shortCircuitResult
  if (plan.rejection) {
    return rejectionResult(
      input,
      plan.rejection.code,
      plan.rejection.message,
      plan.rejection.conflictingInstanceIds,
      constants,
      totalRanked
    )
  }

  const catalog = plan.catalogOverride ?? todaysCatalog
  const effectiveWeight = plan.weightOverride ?? weight
  const effectiveTotalRanked = plan.totalRankedOverride ?? totalRanked

  const { anchors, anchorActivityIds, baseOccupied, anchorPlacements } =
    extractAnchors(plan.workingExisting)
  const excluded = plan.excludeActivityIds
  const activitiesToSolve = [
    ...catalog.filter(
      (a) => !anchorActivityIds.has(a.id) && !(excluded?.has(a.id) ?? false)
    ),
    ...plan.extraActivities,
  ]

  const {
    instances: solved,
    diagnostics,
    status,
  } = runPipeline(
    input,
    constants,
    activitiesToSolve,
    baseOccupied,
    resolve,
    effectiveWeight,
    plan.freezeBoundary,
    [...catalog, ...plan.extraActivities],
    anchorPlacements,
    occurrenceMetaOf
  )

  let allInstances = [...anchors, ...plan.extraInstances, ...solved]
  if (plan.instanceTransform) allInstances = plan.instanceTransform(allInstances)

  const speculative = toResult(
    input,
    allInstances,
    diagnostics,
    status,
    constants,
    effectiveTotalRanked,
    (input.revision ?? 0) + 1
  )

  if (plan.checkRejection) {
    const violation = checkEventRejection(
      [...catalog, ...plan.extraActivities],
      input.existing,
      speculative.timeline.instances
    )
    if (violation) {
      return rejectionResult(
        input,
        violation.code,
        violation.message,
        violation.instanceIds,
        constants,
        totalRanked,
        speculative.timeline
      )
    }
  }

  return speculative
}

/**
 * The group key an event that targets one instance acts on: the whole
 * activity (all of a chunked plan's fragments) when it came from the
 * catalogue, or just that one instance's own id for an ad-hoc without an
 * `activityId` (SPEC.md Section 9.5 — not yet produced by any event this
 * engine implements, but the fallback is cheap to have in place).
 */
function groupKeyOf(inst: TimelineActivity): string {
  return inst.occurrenceId
}

interface EventRejection {
  readonly code: RejectionCode
  readonly message: string
  readonly instanceIds: readonly string[]
}

/**
 * SPEC.md Section 10.2's event-time rejection comparison, generalized across
 * every code that comparison covers: "comparison is against the input
 * timeline, not against feasibility in the abstract" — an activity already
 * skipped before the event doesn't trigger a rejection, only one the event
 * itself pushed out. Every user-intent handler runs its speculative solve
 * through this once, before committing to it. `SPANS_FROZEN_REGION` isn't
 * checked here: anchors (COMPLETED/CARRIED_IN) are excluded from re-solving
 * entirely, so the pipeline itself cannot alter one — that code only ever
 * arises from the top-level finalised-day guard in `solve()`.
 */
function checkEventRejection(
  catalog: readonly Activity[],
  before: readonly TimelineActivity[],
  after: readonly TimelineActivity[]
): EventRejection | null {
  const byActivityId = new Map(catalog.map((a) => [a.id, a]))
  const priorByOccurrence = new Map<string, TimelineActivity>()
  for (const inst of before) {
    priorByOccurrence.set(inst.occurrenceId, inst)
  }
  const afterByOccurrence = new Map<string, TimelineActivity>()
  const afterByActivityId = new Map<string, TimelineActivity>()
  for (const inst of after) {
    afterByOccurrence.set(inst.occurrenceId, inst)
    if (inst.activityId) afterByActivityId.set(inst.activityId, inst)
  }

  for (const inst of after) {
    if (!inst.activityId || inst.state !== "SKIPPED") continue
    const prior = priorByOccurrence.get(inst.occurrenceId)
    if (!prior || prior.state === "SKIPPED") continue
    const activity = byActivityId.get(inst.activityId)
    if (!activity) continue

    if (inst.skipReason === "INFEASIBLE_HARD_CONSTRAINT") {
      const code: RejectionCode = hasFixed(activity)
        ? "FIXED_COLLISION"
        : "MANDATORY_UNPLACEABLE"
      const reason =
        code === "FIXED_COLLISION"
          ? "its fixed time now collides with another fixed activity"
          : "it is mandatory but this action would leave it unplaceable"
      return {
        code,
        message: `"${activity.name}" can't be placed: ${reason}.`,
        instanceIds: [inst.id],
      }
    }

    if (inst.skipReason === "WINDOW_UNSATISFIABLE") {
      const wasGuest = prior.hostInstanceId !== null
      return {
        code: wasGuest ? "GUEST_WINDOW_VIOLATED" : "STRICT_WINDOW_VIOLATED",
        message: wasGuest
          ? `"${activity.name}" no longer fits within its own strict window now that its host has moved.`
          : `"${activity.name}"'s strict window can no longer be satisfied.`,
        instanceIds: [inst.id],
      }
    }

    if (inst.skipReason === "NO_FREE_SPACE" && isDependent(activity)) {
      const rule = sequenceRuleOf(activity)
      const hostAfter = rule
        ? afterByActivityId.get(rule.linkedActivityId)
        : undefined
      if (!hostAfter || hostAfter.state !== "SKIPPED") {
        return {
          code: "SEQUENCE_UNSATISFIABLE",
          message: `"${activity.name}" can no longer be placed adjacent to its host.`,
          instanceIds: [inst.id],
        }
      }
    }
  }

  return null
}

/**
 * SPEC.md Section 9.6's durability rule — "the single most commonly broken
 * behaviour in this spec": an EDIT_INSTANCE_RULES override lives on the
 * instance, not the template, and must be carried forward on every
 * subsequent solve (TICK, SKIP, anything) without the caller replaying the
 * edit event. Since every solve rebuilds today's activities fresh from
 * `input.catalog`, that durability has to be re-applied here, once, before
 * any event-specific handling: any rule tagged `source: "instance"` on an
 * existing instance replaces the template's rule of that type for this
 * solve (or is added, if the template had none of that type).
 */
function applyInstanceRuleOverrides(
  todaysCatalog: readonly Activity[],
  existing: readonly TimelineActivity[]
): Activity[] {
  const overridesByActivity = new Map<string, Map<string, Rule>>()
  for (const inst of existing) {
    if (!inst.activityId) continue
    for (const rule of inst.rules) {
      if (rule.source !== "instance") continue
      const overrides = overridesByActivity.get(inst.activityId) ?? new Map()
      overrides.set(rule.type, rule)
      overridesByActivity.set(inst.activityId, overrides)
    }
  }
  if (overridesByActivity.size === 0) return [...todaysCatalog]

  return todaysCatalog.map((activity) => {
    const overrides = overridesByActivity.get(activity.id)
    if (!overrides) return activity
    const overriddenTypes = new Set(overrides.keys())
    return {
      ...activity,
      rules: [
        ...activity.rules.filter((r) => !overriddenTypes.has(r.type)),
        ...overrides.values(),
      ],
    }
  })
}

/**
 * An ad-hoc instance (SPEC.md Section 9.5) has no catalogue entry, so
 * without this it would vanish the moment any event *other* than
 * ADD_ADHOC re-solves the day — nothing else would know it exists.
 * Reconstructs one pseudo-Activity per still-relevant ad-hoc instance
 * (deduplicated by chunk group) from its own last-known rules, so every
 * event's pipeline sees it as an ordinary candidate. `toResult`'s
 * `tagAdhocInstances` restores the `activityId: null` tagging afterward.
 */
function adhocActivitiesFrom(
  existing: readonly TimelineActivity[]
): Activity[] {
  const seen = new Set<string>()
  const activities: Activity[] = []
  for (const inst of existing) {
    if (!inst.isAdhoc) continue
    const baseId = inst.occurrenceId.split("@")[0]
    if (seen.has(baseId)) continue
    seen.add(baseId)
    activities.push({
      id: baseId,
      name: inst.name,
      durationMinutes: inst.durationMinutes,
      priorityRank: inst.priorityRank,
      enabled: true,
      rules: inst.rules,
      requiredCount: inst.requiredCount,
    })
  }
  return activities
}

/**
 * FINALISE_DAY (SPEC.md Section 9.8): backdate whatever residue is left,
 * snapshot it as today's closed record, and derive the carry-in list for
 * tomorrow's day frame — the engine's only cross-day link; it holds no
 * other state between days. Rejects (INVALID_STATE_FOR_EVENT) if the day
 * hasn't actually ended yet. Once this succeeds, `solve()`'s `finalised`
 * guard refuses every further event against the same input.
 *
 * Only a residue whose stored `plannedEnd` genuinely overflows past
 * `length_minutes` produces a carry-in (SPEC.md Section 3.4) — a
 * midnight-spanning FixedRule (Section 5.1) or an EXTEND that pushed an
 * ACTIVE instance's end past the boundary (edge case 10). Anything else
 * still PLANNED/ACTIVE at this point is not "spanning", just unfinished,
 * and is simply left as-is in today's own record; nothing carries forward
 * for it. Today's own copy of a genuinely spanning instance is clamped to
 * the day boundary ("placed to the day boundary" — edge case 1) and the
 * overflow becomes a locked `CARRIED_IN` anchor occupying `[0, overflow)`
 * on tomorrow's frame.
 */
function solveFinaliseDay(
  input: SolveInput,
  constants: CostConstants,
  totalRanked: number
): SolveResult {
  const lengthMinutes = input.dayFrame.lengthMinutes
  if (input.now < lengthMinutes) {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `The day can't be finalised before it ends (now=${input.now}, length=${lengthMinutes}).`,
      [],
      constants,
      totalRanked
    )
  }

  const { instances: backdated } = applyBackdating(input.existing, input.now)

  const today: TimelineActivity[] = []
  const carryIn: TimelineActivity[] = []
  for (const inst of backdated) {
    const spanning =
      (inst.state === "PLANNED" || inst.state === "ACTIVE") &&
      inst.plannedEnd !== null &&
      inst.plannedEnd > lengthMinutes
    if (!spanning) {
      today.push(inst)
      continue
    }
    const overflow = (inst.plannedEnd as number) - lengthMinutes
    today.push({
      ...inst,
      plannedEnd: lengthMinutes,
      scheduledMinutes: lengthMinutes - (inst.plannedStart as number),
    })
    carryIn.push({
      ...inst,
      state: "CARRIED_IN",
      completedSource: null,
      plannedStart: 0,
      plannedEnd: overflow,
      actualStart: null,
      actualEnd: null,
      scheduledMinutes: overflow,
      spanningFromPreviousDay: true,
      locked: false,
      skipReason: null,
    })
  }

  const { diagnostics, status } = buildDiagnostics(today)
  const cost = scheduleCost(today, lengthMinutes, totalRanked, constants)
  const timeline: Timeline = {
    dayFrame: input.dayFrame,
    revision: (input.revision ?? 0) + 1,
    instances: today,
    diagnostics,
    cost,
    status,
    solvedAtOffset: input.now,
    finalised: true,
    carryIn,
  }

  return { status, timeline, rejection: null, diagnostics, cost, trace: null }
}

function rejectionPlan(
  code: RejectionCode,
  message: string,
  conflictingInstanceIds: readonly string[]
): EventPlan {
  return {
    rejection: { code, message, conflictingInstanceIds, diagnostics: [], bestEffortTimeline: null },
    workingExisting: [],
    freezeBoundary: 0,
    extraActivities: [],
    checkRejection: false,
    extraInstances: [],
    catalogOverride: null,
    weightOverride: null,
    instanceTransform: null,
    totalRankedOverride: null,
    shortCircuitResult: null,
    excludeActivityIds: null,
  }
}

/**
 * SPEC-v2.md §7.1: every event reduces to its preconditions and its
 * mutation. This is the only per-event code; everything else runs through
 * `runEvent`. Semantics are SPEC.md §9 / ALGORITHM.md §14 verbatim.
 */
function planEvent(
  input: SolveInput,
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number
): EventPlan {
  const basePlan: EventPlan = {
    rejection: null,
    workingExisting: input.existing,
    freezeBoundary: input.now,
    extraActivities: [],
    checkRejection: false,
    extraInstances: [],
    catalogOverride: null,
    weightOverride: null,
    instanceTransform: null,
    totalRankedOverride: null,
    shortCircuitResult: null,
    excludeActivityIds: null,
  }

  if (input.event.type === "TICK") {
    const { instances: backdated, changed } = applyBackdating(
      input.existing,
      input.now
    )
    if (!changed) {
      const { diagnostics, status } = buildDiagnostics(backdated)
      return {
        ...basePlan,
        shortCircuitResult: toResult(
          input,
          backdated,
          diagnostics,
          status,
          constants,
          totalRanked,
          input.revision ?? 0
        ),
      }
    }
    return { ...basePlan, workingExisting: backdated }
  }

  if (input.event.type === "SKIP") {
    const event = input.event as { type: "SKIP"; instanceId: string }
    const target = input.existing.find((i) => i.id === event.instanceId)
    if (!target) {
      return rejectionPlan(
        "UNKNOWN_INSTANCE",
        `No instance "${event.instanceId}" in the current timeline.`,
        []
      )
    }
    if (target.state !== "PLANNED") {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${target.name}" is ${target.state}, not PLANNED — it can't be skipped.`,
        [target.id]
      )
    }
    const groupKey = groupKeyOf(target)
    const skippedInstance: TimelineActivity = {
      ...target,
      state: "SKIPPED",
      skipReason: "USER_SKIPPED",
      plannedStart: null,
      plannedEnd: null,
      scheduledMinutes: 0,
      blockIndex: 1,
      blockCount: 1,
      chunkGroupId: null,
      hostInstanceId: null,
      relaxations: [],
      locked: true,
    }
    const workingExisting = input.existing.filter(
      (i) => groupKeyOf(i) !== groupKey
    )
    const excludeIds = target.activityId
      ? new Set([target.activityId])
      : null
    return {
      ...basePlan,
      workingExisting,
      extraInstances: [skippedInstance],
      checkRejection: true,
      excludeActivityIds: excludeIds,
    }
  }

  if (input.event.type === "RESTORE") {
    const event = input.event as { type: "RESTORE"; instanceId: string }
    const target = input.existing.find((i) => i.id === event.instanceId)
    if (!target) {
      return rejectionPlan(
        "UNKNOWN_INSTANCE",
        `No instance "${event.instanceId}" in the current timeline.`,
        []
      )
    }
    if (target.state !== "SKIPPED") {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${target.name}" is ${target.state}, not SKIPPED — there's nothing to restore.`,
        [target.id]
      )
    }
    const groupKey = groupKeyOf(target)
    return {
      ...basePlan,
      workingExisting: input.existing.filter(
        (i) => groupKeyOf(i) !== groupKey
      ),
      checkRejection: true,
    }
  }

  if (input.event.type === "FINISH_EARLY") {
    const event = input.event as {
      type: "FINISH_EARLY"
      instanceId: string
      at: number
    }
    const target = input.existing.find((i) => i.id === event.instanceId)
    if (!target) {
      return rejectionPlan(
        "UNKNOWN_INSTANCE",
        `No instance "${event.instanceId}" in the current timeline.`,
        []
      )
    }
    if (target.state !== "ACTIVE" && target.state !== "CARRIED_IN") {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${target.name}" is ${target.state}, not ACTIVE or CARRIED_IN — it can't be finished early.`,
        [target.id]
      )
    }
    const actualStart = target.actualStart ?? target.plannedStart ?? event.at
    if (
      event.at < actualStart ||
      target.plannedEnd === null ||
      event.at > target.plannedEnd
    ) {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${target.name}" can only finish early between its actual start and its planned end.`,
        [target.id]
      )
    }
    const finished: TimelineActivity = {
      ...target,
      state: "COMPLETED",
      completedSource: "user",
      actualStart,
      actualEnd: event.at,
    }
    return {
      ...basePlan,
      workingExisting: input.existing.map((i) =>
        i.id === target.id ? finished : i
      ),
      freezeBoundary: event.at,
      checkRejection: true,
    }
  }

  if (input.event.type === "EXTEND") {
    const event = input.event as {
      type: "EXTEND"
      instanceId: string
      minutes: number
    }
    const target = input.existing.find((i) => i.id === event.instanceId)
    if (!target) {
      return rejectionPlan(
        "UNKNOWN_INSTANCE",
        `No instance "${event.instanceId}" in the current timeline.`,
        []
      )
    }
    if (target.state !== "ACTIVE") {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${target.name}" is ${target.state}, not ACTIVE — it can't be extended.`,
        [target.id]
      )
    }
    if (
      event.minutes <= 0 ||
      event.minutes % constants.GRID !== 0 ||
      target.plannedEnd === null
    ) {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `An extension must be a positive multiple of ${constants.GRID} minutes.`,
        [target.id]
      )
    }
    const extended: TimelineActivity = {
      ...target,
      plannedEnd: target.plannedEnd + event.minutes,
      scheduledMinutes: target.scheduledMinutes + event.minutes,
    }
    return {
      ...basePlan,
      workingExisting: input.existing.map((i) =>
        i.id === target.id ? extended : i
      ),
      checkRejection: true,
    }
  }

  if (input.event.type === "ADD_ADHOC") {
    const event = input.event as { type: "ADD_ADHOC"; payload: AdhocPayload }
    const { payload } = event
    const adhocId = `adhoc-${input.existing.filter((i) => i.isAdhoc).length + 1}`
    const adhocActivity: Activity = {
      id: adhocId,
      name: payload.name,
      durationMinutes: payload.durationMinutes,
      priorityRank: payload.priorityRank,
      enabled: true,
      rules: payload.rules,
      requiredCount: payload.requiredCount ?? 0,
    }
    const errors = [
      ...validateActivity(adhocActivity, constants),
      ...validateCatalog([...todaysCatalog, adhocActivity]),
    ].filter((i) => i.severity === "error")
    if (errors.length > 0) {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${payload.name}" can't be added: ${errors.map((e) => e.message).join("; ")}`,
        []
      )
    }
    const newTotalRanked = totalRanked + 1
    const adhocWeight = (activity: Activity): number =>
      priorityWeight(activity.priorityRank, newTotalRanked)
    const adhocTransform = (
      instances: readonly TimelineActivity[]
    ): TimelineActivity[] =>
      instances.map((inst) =>
        inst.activityId === adhocId
          ? { ...inst, activityId: null, isAdhoc: true }
          : inst
      )
    return {
      ...basePlan,
      extraActivities: [adhocActivity],
      checkRejection: true,
      weightOverride: adhocWeight,
      totalRankedOverride: newTotalRanked,
      instanceTransform: adhocTransform,
    }
  }

  if (input.event.type === "EDIT_INSTANCE_RULES") {
    const event = input.event as {
      type: "EDIT_INSTANCE_RULES"
      instanceId: string
      rules: readonly Rule[]
    }
    const target = input.existing.find((i) => i.id === event.instanceId)
    if (!target) {
      return rejectionPlan(
        "UNKNOWN_INSTANCE",
        `No instance "${event.instanceId}" in the current timeline.`,
        []
      )
    }
    if (!target.activityId) {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${target.name}" is ad-hoc and has no template rule to override.`,
        [target.id]
      )
    }
    if (target.state === "COMPLETED" || target.state === "CARRIED_IN") {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${target.name}" is ${target.state} — its rules can no longer be edited.`,
        [target.id]
      )
    }
    const templateActivity = todaysCatalog.find(
      (a) => a.id === target.activityId
    ) as Activity
    const overriddenTypes = new Set(event.rules.map((r) => r.type))
    const overrideRules: Rule[] = event.rules.map((r) => ({
      ...r,
      source: "instance" as const,
    }))
    const overriddenActivity: Activity = {
      ...templateActivity,
      rules: [
        ...templateActivity.rules.filter((r) => !overriddenTypes.has(r.type)),
        ...overrideRules,
      ],
    }
    const errors = validateActivity(overriddenActivity, constants).filter(
      (i) => i.severity === "error"
    )
    if (errors.length > 0) {
      return rejectionPlan(
        "INVALID_STATE_FOR_EVENT",
        `"${target.name}"'s rules can't be edited that way: ${errors.map((e) => e.message).join("; ")}`,
        [target.id]
      )
    }
    const effectiveCatalog = todaysCatalog.map((a) =>
      a.id === overriddenActivity.id ? overriddenActivity : a
    )
    const anchorTransform = (
      instances: readonly TimelineActivity[]
    ): TimelineActivity[] =>
      instances.map((a) =>
        a.activityId === overriddenActivity.id
          ? { ...a, rules: overriddenActivity.rules }
          : a
      )
    return {
      ...basePlan,
      catalogOverride: effectiveCatalog,
      checkRejection: true,
      instanceTransform: anchorTransform,
    }
  }

  // GENERATE_DAY — no preconditions, no mutation, no rejection check.
  const { instances: backdated } = applyBackdating(input.existing, input.now)
  return { ...basePlan, workingExisting: backdated }
}

export function solve(input: SolveInput): SolveResult {
  const constants = resolveConstants(input.constants)
  const totalRanked = input.catalog.length

  // SPEC.md Section 9.8: a finalised day refuses every further event.
  if (input.finalised) {
    return rejectionResult(
      input,
      "SPANS_FROZEN_REGION",
      "This day has already been finalised.",
      [],
      constants,
      totalRanked
    )
  }

  if (input.event.type === "FINALISE_DAY") {
    return solveFinaliseDay(input, constants, totalRanked)
  }

  // SPEC.md Section 8.3 step 4 / 3.4: carry-in blocks from a prior day's
  // FINALISE_DAY are anchors from this day's very first solve onward. The
  // caller supplies them exactly once — typically alongside GENERATE_DAY —
  // and every later event of the same day already carries them forward
  // inside `existing` (the same convention `existing` itself already
  // relies on for ACTIVE/COMPLETED anchors), so folding them in here is
  // safe by calling convention rather than by de-duplication.
  const seededInput: SolveInput =
    input.carryIn.length > 0
      ? {
          ...input,
          existing: [...input.carryIn, ...input.existing],
          carryIn: [],
        }
      : input

  const weekday = weekdayOf(seededInput.dayFrame.date)
  const frame = seededInput.dayFrame

  // SPEC-v2.1 §15 row 2: over a multi-day GENERATE_DAY, a plain recurring
  // activity gets one placement target per eligible day (matching what N
  // chained 1-day solves would produce) instead of one for the whole frame.
  // Scoped narrowly — see expandDailyOccurrences's docstring for why
  // Fixed/Overlap/Sequence-involved activities and every other event type
  // keep today's single-instance-per-frame behavior untouched.
  const isMultiDayGenerate =
    input.event.type === "GENERATE_DAY" && frame.dayCount > 1
  const occurrenceMeta = new Map<string, { sourceId: string; day: Day }>()
  let baseCatalog: readonly Activity[]

  if (isMultiDayGenerate) {
    const occurrences = expandDailyOccurrences(
      seededInput.catalog.filter((a) => a.enabled),
      frame
    )
    for (const occ of occurrences) {
      if (occ.ghost.id !== occ.sourceId) {
        occurrenceMeta.set(occ.ghost.id, {
          sourceId: occ.sourceId,
          day: occ.day,
        })
      }
    }
    baseCatalog = occurrences.map((occ) => occ.ghost)
  } else {
    baseCatalog = seededInput.catalog.filter(
      (a) => a.enabled && isEligibleOnDay(a, weekday)
    )
  }

  const occurrenceMetaOf: OccurrenceMetaOf = (activity) => {
    const meta = occurrenceMeta.get(activity.id)
    return meta
      ? { ...meta, isGhost: true }
      : { sourceId: activity.id, day: frame.days[0], isGhost: false }
  }

  const resolvedCache = new Map<string, ResolvedActivity>()
  const resolve = (activity: Activity): ResolvedActivity => {
    let resolved = resolvedCache.get(activity.id)
    if (!resolved) {
      const meta = occurrenceMeta.get(activity.id)
      let windows: ResolvedActivity["windows"]
      if (meta) {
        // Ghosted activity: restrict windows to this ghost's own day, so it
        // competes only for that day's free time — the resolve.ts-level
        // resolveWindows already spans every eligible day in the frame.
        const dayWindows = resolveWindows(activity, frame).filter(
          (w) => w.dayIndex === meta.day.index
        )
        windows =
          dayWindows.length > 0
            ? dayWindows
            : [
                {
                  start: meta.day.startOffset,
                  end: meta.day.startOffset + meta.day.lengthMinutes,
                  maxDriftMinutes: 0,
                  dayIndex: meta.day.index,
                },
              ]
      } else {
        windows = resolveWindows(activity, frame)
      }
      resolved = { activity, windows }
      resolvedCache.set(activity.id, resolved)
    }
    return resolved
  }
  const weight = (activity: Activity): number =>
    priorityWeight(activity.priorityRank, totalRanked)

  const todaysCatalog = applyInstanceRuleOverrides(
    [...baseCatalog, ...adhocActivitiesFrom(seededInput.existing)],
    seededInput.existing
  )

  const plan = planEvent(
    seededInput,
    constants,
    todaysCatalog,
    resolve,
    weight,
    totalRanked
  )
  return runEvent(
    seededInput,
    plan,
    constants,
    todaysCatalog,
    resolve,
    weight,
    totalRanked,
    occurrenceMetaOf
  )
}
