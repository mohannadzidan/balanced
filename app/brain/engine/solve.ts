import { priorityWeight, scheduleCost } from "./cost"
import { resolveConstants } from "./constants"
import { evaluateCandidate } from "./placement"
import { placeGreedy } from "./greedy"
import { placeFixedSet, placeHardSet } from "./hard-set"
import { resolveActivity, type ResolvedActivity } from "./resolve"
import { isDependent, placeSequenceChain } from "./sequence"
import { weekdayOf } from "./time"
import type {
  Activity,
  DayFrame,
  Diagnostic,
  Interval,
  Placement,
  Relaxation,
  SkipReason,
  SolveInput,
  SolveResult,
  Timeline,
  TimelineActivity,
  TimelineStatus,
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
  const verdict = evaluateCandidate(resolved, placement.start, placement.end)
  return verdict.driftMinutes > 0
    ? [{ type: "drift", minutes: verdict.driftMinutes }]
    : []
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
 * Engine build step 6 (SPEC.md Section 16): StrictWindowRule and
 * FlexibleWindowRule feasibility, with cost-aware candidate selection now
 * that drift has a price. Shrink, sequence, overlap, and events remain for
 * later build steps — `GENERATE_DAY` only.
 */
export function solve(input: SolveInput): SolveResult {
  const constants = resolveConstants(input.constants)
  const grid = constants.GRID
  const nodeLimit = constants.HARD_SET_NODE_LIMIT
  const freezeBoundary = input.now
  const lengthMinutes = input.dayFrame.lengthMinutes
  const weekday = weekdayOf(input.dayFrame.date)
  const totalRanked = input.catalog.length

  const resolvedCache = new Map<string, ResolvedActivity>()
  const resolve = (activity: Activity): ResolvedActivity => {
    let resolved = resolvedCache.get(activity.id)
    if (!resolved) {
      resolved = resolveActivity(activity, input.dayFrame)
      resolvedCache.set(activity.id, resolved)
    }
    return resolved
  }
  const weight = (activity: Activity): number =>
    priorityWeight(activity.priorityRank, totalRanked)

  const todaysCatalog = input.catalog.filter(
    (a) => a.enabled && a.allowedDays.includes(weekday)
  )

  // Sequence dependents (SPEC.md Section 5.6) are placed adjacent to their
  // host out of priority order, so they sit outside the normal hard-set /
  // discretionary partitioning below. A dependent that is itself Fixed keeps
  // its declared time and is treated as an ordinary host instead — there is
  // nothing left for the sequence relationship to solve for it.
  const sequenceDependents = todaysCatalog.filter(
    (a) => isDependent(a) && !hasFixed(a)
  )
  const hostPool = todaysCatalog.filter((a) => !sequenceDependents.includes(a))

  // Phase 1a: FixedRule activities, placed at their declared times.
  const fixedSet = hostPool.filter(hasFixed)
  const fixedOutcome = placeFixedSet(fixedSet, input.dayFrame, freezeBoundary)
  const occupiedAfterFixed: Interval[] = [
    ...fixedOutcome.placements.values(),
  ].map((p) => ({ start: p.start, end: p.end }))

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
  const greedyOutcome = placeGreedy(discretionary, occupiedAfterHardSet, {
    freezeBoundary,
    grid,
    lengthMinutes,
    constants,
    resolve,
    weight,
  })
  const occupiedAfterGreedy: Interval[] = [
    ...occupiedAfterHardSet,
    ...[...greedyOutcome.placements.values()].map((p) => ({
      start: p.start,
      end: p.end,
    })),
  ]

  // Phase 2.5: sequence dependents, adjacent to their already-placed host.
  const hostResolutions = new Map<string, Placement | "SKIPPED">()
  for (const activity of hostPool) {
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

  const instances = todaysCatalog.map((activity) => {
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
    return freshInstance(
      activity,
      input.dayFrame,
      placement,
      skipReason,
      relaxations
    )
  })

  const diagnostics: Diagnostic[] = [...fixedOutcome.diagnostics]
  let status: TimelineStatus =
    fixedOutcome.diagnostics.length > 0 ? "DEGRADED" : "OK"

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
  }

  const cost = scheduleCost(instances, lengthMinutes, totalRanked, constants)

  const timeline: Timeline = {
    dayFrame: input.dayFrame,
    revision: 1,
    instances,
    diagnostics,
    cost,
    status,
    solvedAtOffset: input.now,
    finalised: false,
  }

  return {
    status,
    timeline,
    rejection: null,
    diagnostics,
    cost,
    trace: null,
  }
}
