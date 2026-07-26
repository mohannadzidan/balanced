import { priorityWeight, scheduleCost } from "./cost"
import { resolveConstants } from "./constants"
import { applyBackdating } from "./lifecycle"
import { evaluateCandidate } from "./placement"
import { placeGreedy } from "./greedy"
import { placeFixedSet, placeHardSet } from "./hard-set"
import { resolveActivity, type ResolvedActivity } from "./resolve"
import { isDependent, placeSequenceChain, sequenceRuleOf } from "./sequence"
import { weekdayOf } from "./time"
import { validateActivity, validateCatalog } from "./validation"
import type {
  Activity,
  AdhocPayload,
  CostConstants,
  DayFrame,
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
  Weekday,
} from "./types"

function hasFixed(activity: Activity): boolean {
  return activity.rules.some((r) => r.type === "fixed")
}

function hasMandatory(activity: Activity): boolean {
  return activity.rules.some((r) => r.type === "mandatory")
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
  dayFrame: DayFrame,
  placement: Placement | null,
  skipReason: SkipReason | null,
  relaxations: readonly Relaxation[]
): TimelineActivity {
  return {
    id: activity.id,
    activityId: activity.id,
    date: dayFrame.date,
    name: activity.name,
    durationMinutes: activity.durationMinutes,
    priorityRank: activity.priorityRank,
    rules: activity.rules,
    state: placement ? "PLANNED" : "SKIPPED",
    completedSource: null,
    plannedStart: placement ? placement.start : null,
    plannedEnd: placement ? placement.end : null,
    actualStart: null,
    actualEnd: null,
    scheduledMinutes: placement ? placement.end - placement.start : 0,
    chunkIndex: 1,
    chunkCount: 1,
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
  dayFrame: DayFrame,
  resolved: ResolvedActivity,
  chunkPlacements: readonly Placement[]
): TimelineActivity[] {
  const sorted = [...chunkPlacements].sort((a, b) => a.start - b.start)
  const totalScheduled = sorted.reduce((sum, c) => sum + (c.end - c.start), 0)
  const shrunkBy = activity.durationMinutes - totalScheduled

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
      id: `${activity.id}#${index + 1}`,
      activityId: activity.id,
      date: dayFrame.date,
      name: activity.name,
      durationMinutes: activity.durationMinutes,
      priorityRank: activity.priorityRank,
      rules: activity.rules,
      state: "PLANNED",
      completedSource: null,
      plannedStart: placement.start,
      plannedEnd: placement.end,
      actualStart: null,
      actualEnd: null,
      scheduledMinutes: placement.end - placement.start,
      chunkIndex: index + 1,
      chunkCount: sorted.length,
      chunkGroupId: activity.id,
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
  anchorPlacements: ReadonlyMap<string, Placement> = new Map()
): PipelineOutcome {
  const grid = constants.GRID
  const nodeLimit = constants.HARD_SET_NODE_LIMIT
  const lengthMinutes = input.dayFrame.lengthMinutes

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
  const mandatorySet = hostPool.filter((a) => hasMandatory(a) && !hasFixed(a))
  const hardOutcome = placeHardSet(mandatorySet, occupiedAfterFixed, {
    freezeBoundary,
    grid,
    lengthMinutes,
    nodeLimit,
    constants,
    resolve,
    weight,
    dayFrame: input.dayFrame,
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
    const chunksPlaced = greedyOutcome.chunks.get(activity.id)
    if (chunksPlaced) {
      return chunkedInstances(
        activity,
        input.dayFrame,
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
        input.dayFrame,
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

    if (inst.chunkIndex !== 1) continue // avoid double-reporting a chunked plan

    const shrink = inst.relaxations.find((r) => r.type === "shrink")
    if (shrink && inst.chunkCount === 1) {
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
        message: `"${inst.name}" was split into ${inst.chunkCount} blocks.`,
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
  // instance id instead — see `groupKeyOf`.
  const anchorActivityIds = new Set(anchors.map((a) => groupKeyOf(a)))
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
      groupKeyOf(a),
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
 * TICK (SPEC.md Section 9.2), the "null event": apply auto-start /
 * auto-complete backdating to `existing`, then — only if something actually
 * changed — re-solve everything not anchored by that backdating. An anchor
 * is an existing instance whose *every* fragment (chunking aside — see
 * below) already reached ACTIVE/COMPLETED/CARRIED_IN; its occupied time is
 * fed into the pipeline as pre-existing occupancy and its instance is
 * echoed back untouched. Calling TICK twice with the same `now` is a no-op:
 * `changed` is false the second time, so the input timeline round-trips
 * with its revision unchanged, exactly as Section 9.2 requires.
 *
 * A chunked activity (chunkGroupId set) is never treated as an anchor here:
 * partial completion of a chunk plan across ticks is a cross-feature
 * interaction no worked example exercises yet, so a chunked activity is
 * always re-solved fresh from its template, ignoring any fragment that
 * already ran. This mirrors the same kind of documented scope boundary
 * used for chunked hosts in the sequence and overlap phases.
 */
function solveTick(
  input: SolveInput,
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number
): SolveResult {
  const { instances: backdated, changed } = applyBackdating(
    input.existing,
    input.now
  )

  if (!changed) {
    const { diagnostics, status } = buildDiagnostics(backdated)
    return toResult(
      input,
      backdated,
      diagnostics,
      status,
      constants,
      totalRanked,
      input.revision ?? 0
    )
  }

  const { anchors, anchorActivityIds, baseOccupied, anchorPlacements } =
    extractAnchors(backdated)
  const activitiesToSolve = todaysCatalog.filter(
    (a) => !anchorActivityIds.has(a.id)
  )

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
    weight,
    input.now,
    todaysCatalog,
    anchorPlacements
  )

  return toResult(
    input,
    [...anchors, ...solved],
    diagnostics,
    status,
    constants,
    totalRanked,
    (input.revision ?? 0) + 1
  )
}

/**
 * GENERATE_DAY (SPEC.md Section 8.3 step 4-5): the initial event for a day
 * frame. `existing` is ordinarily empty, but a caller may seed it with
 * yesterday's carry-in (SPEC.md Section 3.4) — any such anchor must be
 * preserved verbatim and excluded from fresh candidate generation, exactly
 * like every other event. Unlike TICK, there's no "nothing changed, echo
 * back" short-circuit: backdating an empty `existing` trivially reports no
 * change, but the day still needs its first real solve.
 */
function solveGenerate(
  input: SolveInput,
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number
): SolveResult {
  const { instances: backdated } = applyBackdating(input.existing, input.now)
  const { anchors, anchorActivityIds, baseOccupied, anchorPlacements } =
    extractAnchors(backdated)
  const activitiesToSolve = todaysCatalog.filter(
    (a) => !anchorActivityIds.has(a.id)
  )

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
    weight,
    input.now,
    todaysCatalog,
    anchorPlacements
  )

  return toResult(
    input,
    [...anchors, ...solved],
    diagnostics,
    status,
    constants,
    totalRanked,
    1
  )
}

/**
 * The group key an event that targets one instance acts on: the whole
 * activity (all of a chunked plan's fragments) when it came from the
 * catalogue, or just that one instance's own id for an ad-hoc without an
 * `activityId` (SPEC.md Section 9.5 — not yet produced by any event this
 * engine implements, but the fallback is cheap to have in place).
 */
function groupKeyOf(inst: TimelineActivity): string {
  return inst.activityId ?? inst.id
}

/**
 * SKIP (SPEC.md Section 9.7): mark a PLANNED instance user-skipped and
 * re-solve everything else. Never rejected except for a malformed request
 * (unknown instance, or one not currently PLANNED). The skip is recorded
 * with `locked: true` so it survives future re-solves (TICK and so on)
 * until a matching RESTORE lifts it — see `extractAnchors`.
 */
function solveSkip(
  input: SolveInput & { readonly event: { type: "SKIP"; instanceId: string } },
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number
): SolveResult {
  const target = input.existing.find((i) => i.id === input.event.instanceId)
  if (!target) {
    return rejectionResult(
      input,
      "UNKNOWN_INSTANCE",
      `No instance "${input.event.instanceId}" in the current timeline.`,
      [],
      constants,
      totalRanked
    )
  }
  if (target.state !== "PLANNED") {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${target.name}" is ${target.state}, not PLANNED — it can't be skipped.`,
      [target.id],
      constants,
      totalRanked
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
    chunkIndex: 1,
    chunkCount: 1,
    chunkGroupId: null,
    hostInstanceId: null,
    relaxations: [],
    locked: true,
  }

  const { anchors, anchorActivityIds, baseOccupied, anchorPlacements } =
    extractAnchors(input.existing.filter((i) => groupKeyOf(i) !== groupKey))
  const activitiesToSolve = todaysCatalog.filter(
    (a) => !anchorActivityIds.has(a.id) && a.id !== groupKey
  )

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
    weight,
    input.now,
    todaysCatalog,
    anchorPlacements
  )

  const speculative = toResult(
    input,
    [...anchors, skippedInstance, ...solved],
    diagnostics,
    status,
    constants,
    totalRanked,
    (input.revision ?? 0) + 1
  )
  const violation = checkEventRejection(
    todaysCatalog,
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
  return speculative
}

/**
 * RESTORE (SPEC.md Section 9.7): lift a user skip and re-solve. Lifting the
 * mark is just excluding the old skipped instance from the anchor set
 * before re-solving — since it's no longer `locked`, its activity is a
 * completely ordinary candidate again. If there's genuinely no room, it
 * comes back SKIPPED with whatever reason the pipeline finds this time,
 * not necessarily `USER_SKIPPED` — that's not itself a rejection (the
 * activity being restored was already SKIPPED beforehand, so
 * `checkEventRejection` never blames this event for it), but restoring one
 * activity can still legitimately displace and reject a *different* one.
 */
function solveRestore(
  input: SolveInput & {
    readonly event: { type: "RESTORE"; instanceId: string }
  },
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number
): SolveResult {
  const target = input.existing.find((i) => i.id === input.event.instanceId)
  if (!target) {
    return rejectionResult(
      input,
      "UNKNOWN_INSTANCE",
      `No instance "${input.event.instanceId}" in the current timeline.`,
      [],
      constants,
      totalRanked
    )
  }
  if (target.state !== "SKIPPED") {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${target.name}" is ${target.state}, not SKIPPED — there's nothing to restore.`,
      [target.id],
      constants,
      totalRanked
    )
  }

  const groupKey = groupKeyOf(target)
  const { anchors, anchorActivityIds, baseOccupied, anchorPlacements } =
    extractAnchors(input.existing.filter((i) => groupKeyOf(i) !== groupKey))
  const activitiesToSolve = todaysCatalog.filter(
    (a) => !anchorActivityIds.has(a.id)
  )

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
    weight,
    input.now,
    todaysCatalog,
    anchorPlacements
  )

  const speculative = toResult(
    input,
    [...anchors, ...solved],
    diagnostics,
    status,
    constants,
    totalRanked,
    (input.revision ?? 0) + 1
  )
  const violation = checkEventRejection(
    todaysCatalog,
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
  return speculative
}

/**
 * FINISH_EARLY (SPEC.md Section 9.3): complete an ACTIVE instance ahead of
 * its planned end and re-solve the remainder against a freeze boundary
 * moved back to `at` — not `input.now` — so the reclaimed time between `at`
 * and the old planned end is immediately available to the rest of the day.
 * There's no separate "reuse the freed time" step: a from-scratch re-solve
 * of everything not anchored naturally restores whatever a previously
 * shrunk or skipped activity can now fit. Freeing time is normally
 * harmless, but a sequence dependent bound to this instance's old span
 * could in principle lose its adjacency — `checkEventRejection` covers
 * that alongside every other event.
 *
 * Also legal against a `CARRIED_IN` block (SPEC.md 11 edge case 2): a
 * midnight-spanning activity's overflow into today is just as finishable
 * ahead of schedule as an ordinary ACTIVE one, and the same completion +
 * re-solve logic applies unchanged once its state is treated as an anchor.
 */
function solveFinishEarly(
  input: SolveInput & {
    readonly event: { type: "FINISH_EARLY"; instanceId: string; at: number }
  },
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number
): SolveResult {
  const { instanceId, at } = input.event
  const target = input.existing.find((i) => i.id === instanceId)
  if (!target) {
    return rejectionResult(
      input,
      "UNKNOWN_INSTANCE",
      `No instance "${instanceId}" in the current timeline.`,
      [],
      constants,
      totalRanked
    )
  }
  if (target.state !== "ACTIVE" && target.state !== "CARRIED_IN") {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${target.name}" is ${target.state}, not ACTIVE or CARRIED_IN — it can't be finished early.`,
      [target.id],
      constants,
      totalRanked
    )
  }
  // A CARRIED_IN block (SPEC.md 11 edge case 2) has no actualStart of its
  // own yet — it's been "running" since this day frame's own start.
  const actualStart = target.actualStart ?? target.plannedStart ?? at
  if (
    at < actualStart ||
    target.plannedEnd === null ||
    at > target.plannedEnd
  ) {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${target.name}" can only finish early between its actual start and its planned end.`,
      [target.id],
      constants,
      totalRanked
    )
  }

  const finished: TimelineActivity = {
    ...target,
    state: "COMPLETED",
    completedSource: "user",
    actualStart,
    actualEnd: at,
  }
  const workingExisting = input.existing.map((i) =>
    i.id === target.id ? finished : i
  )

  const { anchors, anchorActivityIds, baseOccupied, anchorPlacements } =
    extractAnchors(workingExisting)
  const activitiesToSolve = todaysCatalog.filter(
    (a) => !anchorActivityIds.has(a.id)
  )

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
    weight,
    at,
    todaysCatalog,
    anchorPlacements
  )

  const speculative = toResult(
    input,
    [...anchors, ...solved],
    diagnostics,
    status,
    constants,
    totalRanked,
    (input.revision ?? 0) + 1
  )
  const violation = checkEventRejection(
    todaysCatalog,
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
  return speculative
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
  const priorByActivity = new Map<string, TimelineActivity>()
  for (const inst of before) {
    if (inst.activityId) priorByActivity.set(inst.activityId, inst)
  }
  const afterByActivity = new Map<string, TimelineActivity>()
  for (const inst of after) {
    if (inst.activityId) afterByActivity.set(inst.activityId, inst)
  }

  for (const inst of after) {
    if (!inst.activityId || inst.state !== "SKIPPED") continue
    const prior = priorByActivity.get(inst.activityId)
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
        ? afterByActivity.get(rule.linkedActivityId)
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
 * EXTEND (SPEC.md Section 9.4): push an ACTIVE instance's planned end out
 * by `minutes` (a positive multiple of GRID) and freeze it there, then
 * re-solve the remainder at the ordinary `now` boundary. This is the event
 * SPEC.md's own worked examples (14.2, 14.3) use to exercise rejection: if
 * it newly displaces a mandatory activity that was placed before the event,
 * the input timeline is returned unchanged with a rejection instead —
 * `checkEventRejection` decides exactly which code.
 */
function solveExtend(
  input: SolveInput & {
    readonly event: { type: "EXTEND"; instanceId: string; minutes: number }
  },
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number
): SolveResult {
  const { instanceId, minutes } = input.event
  const target = input.existing.find((i) => i.id === instanceId)
  if (!target) {
    return rejectionResult(
      input,
      "UNKNOWN_INSTANCE",
      `No instance "${instanceId}" in the current timeline.`,
      [],
      constants,
      totalRanked
    )
  }
  if (target.state !== "ACTIVE") {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${target.name}" is ${target.state}, not ACTIVE — it can't be extended.`,
      [target.id],
      constants,
      totalRanked
    )
  }
  if (
    minutes <= 0 ||
    minutes % constants.GRID !== 0 ||
    target.plannedEnd === null
  ) {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `An extension must be a positive multiple of ${constants.GRID} minutes.`,
      [target.id],
      constants,
      totalRanked
    )
  }

  const extended: TimelineActivity = {
    ...target,
    plannedEnd: target.plannedEnd + minutes,
    scheduledMinutes: target.scheduledMinutes + minutes,
  }
  const workingExisting = input.existing.map((i) =>
    i.id === target.id ? extended : i
  )

  const { anchors, anchorActivityIds, baseOccupied, anchorPlacements } =
    extractAnchors(workingExisting)
  const activitiesToSolve = todaysCatalog.filter(
    (a) => !anchorActivityIds.has(a.id)
  )

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
    weight,
    input.now,
    todaysCatalog,
    anchorPlacements
  )

  const speculative = toResult(
    input,
    [...anchors, ...solved],
    diagnostics,
    status,
    constants,
    totalRanked,
    (input.revision ?? 0) + 1
  )
  const violation = checkEventRejection(
    todaysCatalog,
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
  return speculative
}

/**
 * ADD_ADHOC (SPEC.md Section 9.5): create a one-off TimelineActivity that
 * was never part of the catalogue — `activity_id: null`, `is_adhoc: true` —
 * and let it compete for placement on equal footing, full rule vocabulary
 * included. The catalogue itself is never touched (the pure-function
 * guarantee). Its id is derived purely from how many ad-hoc instances
 * already exist in `existing`, keeping the engine deterministic without
 * reading a clock or a random source. Rejected (INVALID_STATE_FOR_EVENT)
 * if the payload fails the same catalogue validation a template would —
 * incompatible rules, off-grid values, a colliding priority rank, and so
 * on (SPEC.md Section 10.1). An ad-hoc that outranks and displaces existing
 * activities is legal (SPEC.md 11 edge case 16) — only a genuine regression
 * of a previously-placed activity (worked example 14.4: a fixed ad-hoc
 * squeezing out a mandatory Work) is rejected, via `checkEventRejection`.
 */
function solveAddAdhoc(
  input: SolveInput & {
    readonly event: { type: "ADD_ADHOC"; payload: AdhocPayload }
  },
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  totalRanked: number
): SolveResult {
  const { payload } = input.event
  const weekday = weekdayOf(input.dayFrame.date)
  const adhocId = `adhoc-${input.existing.filter((i) => i.isAdhoc).length + 1}`
  const adhocActivity: Activity = {
    id: adhocId,
    name: payload.name,
    durationMinutes: payload.durationMinutes,
    priorityRank: payload.priorityRank,
    allowedDays: [weekday],
    enabled: true,
    rules: payload.rules,
  }

  const errors = [
    ...validateActivity(adhocActivity, constants),
    ...validateCatalog([...todaysCatalog, adhocActivity]),
  ].filter((i) => i.severity === "error")
  if (errors.length > 0) {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${payload.name}" can't be added: ${errors.map((e) => e.message).join("; ")}`,
      [],
      constants,
      totalRanked
    )
  }

  const newTotalRanked = totalRanked + 1
  const adhocWeight = (activity: Activity): number =>
    priorityWeight(activity.priorityRank, newTotalRanked)

  const { anchors, anchorActivityIds, baseOccupied, anchorPlacements } =
    extractAnchors(input.existing)
  const activitiesToSolve = [
    ...todaysCatalog.filter((a) => !anchorActivityIds.has(a.id)),
    adhocActivity,
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
    adhocWeight,
    input.now,
    [...todaysCatalog, adhocActivity],
    anchorPlacements
  )

  const finalInstances = [...anchors, ...solved].map((inst) =>
    inst.activityId === adhocId
      ? { ...inst, activityId: null, isAdhoc: true }
      : inst
  )

  const speculative = toResult(
    input,
    finalInstances,
    diagnostics,
    status,
    constants,
    newTotalRanked,
    (input.revision ?? 0) + 1
  )
  const violation = checkEventRejection(
    [...todaysCatalog, adhocActivity],
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
  return speculative
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
  existing: readonly TimelineActivity[],
  weekday: Weekday
): Activity[] {
  const seen = new Set<string>()
  const activities: Activity[] = []
  for (const inst of existing) {
    if (!inst.isAdhoc) continue
    const key = groupKeyOf(inst)
    if (seen.has(key)) continue
    seen.add(key)
    activities.push({
      id: key,
      name: inst.name,
      durationMinutes: inst.durationMinutes,
      priorityRank: inst.priorityRank,
      allowedDays: [weekday],
      enabled: true,
      rules: inst.rules,
    })
  }
  return activities
}

/**
 * EDIT_INSTANCE_RULES (SPEC.md Section 9.6): replace one or more of an
 * instance's rules for today only, without touching the template — the
 * canonical case is adding an ad-hoc's id to today's Work OverlapRule. The
 * override is written onto the resulting instance with `source: "instance"`
 * and re-solved through the ordinary pipeline (`applyInstanceRuleOverrides`
 * at the top of `solve()` is what makes it durable across later events).
 * Scoped to catalogue-backed instances — an ad-hoc has no template to
 * override in the first place. An edit that leaves a previously-placed
 * activity (possibly the edited one itself) newly unplaceable is rejected,
 * via `checkEventRejection`.
 */
function solveEditInstanceRules(
  input: SolveInput & {
    readonly event: {
      type: "EDIT_INSTANCE_RULES"
      instanceId: string
      rules: readonly Rule[]
    }
  },
  constants: CostConstants,
  todaysCatalog: readonly Activity[],
  resolve: (activity: Activity) => ResolvedActivity,
  weight: (activity: Activity) => number,
  totalRanked: number
): SolveResult {
  const { instanceId, rules } = input.event
  const target = input.existing.find((i) => i.id === instanceId)
  if (!target) {
    return rejectionResult(
      input,
      "UNKNOWN_INSTANCE",
      `No instance "${instanceId}" in the current timeline.`,
      [],
      constants,
      totalRanked
    )
  }
  if (!target.activityId) {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${target.name}" is ad-hoc and has no template rule to override.`,
      [target.id],
      constants,
      totalRanked
    )
  }
  if (target.state === "COMPLETED" || target.state === "CARRIED_IN") {
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${target.name}" is ${target.state} — its rules can no longer be edited.`,
      [target.id],
      constants,
      totalRanked
    )
  }

  const templateActivity = todaysCatalog.find(
    (a) => a.id === target.activityId
  ) as Activity
  const overriddenTypes = new Set(rules.map((r) => r.type))
  const overrideRules: Rule[] = rules.map((r) => ({
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
    return rejectionResult(
      input,
      "INVALID_STATE_FOR_EVENT",
      `"${target.name}"'s rules can't be edited that way: ${errors.map((e) => e.message).join("; ")}`,
      [target.id],
      constants,
      totalRanked
    )
  }

  const effectiveCatalog = todaysCatalog.map((a) =>
    a.id === overriddenActivity.id ? overriddenActivity : a
  )
  const {
    anchors: rawAnchors,
    anchorActivityIds,
    baseOccupied,
    anchorPlacements,
  } = extractAnchors(input.existing)
  // If the edited activity is itself anchored (e.g. an ACTIVE Work), its own
  // instance's `rules` must carry the override too — that's what makes the
  // durability mechanism (applyInstanceRuleOverrides) see it on the *next*
  // solve. Anchors that aren't the target pass through untouched.
  const anchors = rawAnchors.map((a) =>
    a.activityId === overriddenActivity.id
      ? { ...a, rules: overriddenActivity.rules }
      : a
  )
  const activitiesToSolve = effectiveCatalog.filter(
    (a) => !anchorActivityIds.has(a.id)
  )

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
    weight,
    input.now,
    effectiveCatalog,
    anchorPlacements
  )

  const speculative = toResult(
    input,
    [...anchors, ...solved],
    diagnostics,
    status,
    constants,
    totalRanked,
    (input.revision ?? 0) + 1
  )
  const violation = checkEventRejection(
    effectiveCatalog,
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
  return speculative
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
  const resolvedCache = new Map<string, ResolvedActivity>()
  const resolve = (activity: Activity): ResolvedActivity => {
    let resolved = resolvedCache.get(activity.id)
    if (!resolved) {
      resolved = resolveActivity(activity, seededInput.dayFrame)
      resolvedCache.set(activity.id, resolved)
    }
    return resolved
  }
  const weight = (activity: Activity): number =>
    priorityWeight(activity.priorityRank, totalRanked)

  const todaysCatalog = applyInstanceRuleOverrides(
    [
      ...seededInput.catalog.filter(
        (a) => a.enabled && a.allowedDays.includes(weekday)
      ),
      ...adhocActivitiesFrom(seededInput.existing, weekday),
    ],
    seededInput.existing
  )

  if (seededInput.event.type === "TICK") {
    return solveTick(
      seededInput,
      constants,
      todaysCatalog,
      resolve,
      weight,
      totalRanked
    )
  }
  if (seededInput.event.type === "SKIP") {
    return solveSkip(
      { ...seededInput, event: seededInput.event },
      constants,
      todaysCatalog,
      resolve,
      weight,
      totalRanked
    )
  }
  if (seededInput.event.type === "RESTORE") {
    return solveRestore(
      { ...seededInput, event: seededInput.event },
      constants,
      todaysCatalog,
      resolve,
      weight,
      totalRanked
    )
  }
  if (seededInput.event.type === "FINISH_EARLY") {
    return solveFinishEarly(
      { ...seededInput, event: seededInput.event },
      constants,
      todaysCatalog,
      resolve,
      weight,
      totalRanked
    )
  }
  if (seededInput.event.type === "EXTEND") {
    return solveExtend(
      { ...seededInput, event: seededInput.event },
      constants,
      todaysCatalog,
      resolve,
      weight,
      totalRanked
    )
  }
  if (seededInput.event.type === "ADD_ADHOC") {
    return solveAddAdhoc(
      { ...seededInput, event: seededInput.event },
      constants,
      todaysCatalog,
      resolve,
      totalRanked
    )
  }
  if (seededInput.event.type === "EDIT_INSTANCE_RULES") {
    return solveEditInstanceRules(
      { ...seededInput, event: seededInput.event },
      constants,
      todaysCatalog,
      resolve,
      weight,
      totalRanked
    )
  }

  return solveGenerate(
    seededInput,
    constants,
    todaysCatalog,
    resolve,
    weight,
    totalRanked
  )
}
