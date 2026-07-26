import { DEFAULT_COST_CONSTANTS } from "./constants"
import { placeGreedy } from "./greedy"
import { placeFixedSet, placeHardSet } from "./hard-set"
import { weekdayOf } from "./time"
import type {
  Activity,
  CostBreakdown,
  DayFrame,
  Diagnostic,
  Interval,
  Placement,
  SkipReason,
  SolveInput,
  SolveResult,
  Timeline,
  TimelineActivity,
  TimelineStatus,
} from "./types"

const ZERO_COST: CostBreakdown = {
  total: 0,
  skip: 0,
  shrink: 0,
  chunk: 0,
  drift: 0,
  gap: 0,
  idle: 0,
  perInstance: {},
}

function hasFixed(activity: Activity): boolean {
  return activity.rules.some((r) => r.type === "fixed")
}

function hasMandatory(activity: Activity): boolean {
  return activity.rules.some((r) => r.type === "mandatory")
}

function freshInstance(
  activity: Activity,
  dayFrame: DayFrame,
  placement: Placement | null,
  skipReason: SkipReason | null
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
    relaxations: [],
    locked: false,
    skipReason,
  }
}

/**
 * Engine build step 5 (SPEC.md Section 16): the two-pass solver structure.
 * Phase 1 places the hard set (FixedRule, then MandatoryRule) before
 * anything discretionary is considered, so a low-priority mandatory
 * activity is never crowded out by higher-priority optional ones. Phase 2
 * greedily places the rest by priority rank. Window rules, shrink, sequence,
 * overlap, cost-based candidate selection, and events all land in later
 * build steps — `GENERATE_DAY` only, cost is still a zero placeholder.
 */
export function solve(input: SolveInput): SolveResult {
  const grid = input.constants?.GRID ?? DEFAULT_COST_CONSTANTS.GRID
  const nodeLimit =
    input.constants?.HARD_SET_NODE_LIMIT ??
    DEFAULT_COST_CONSTANTS.HARD_SET_NODE_LIMIT
  const freezeBoundary = input.now
  const lengthMinutes = input.dayFrame.lengthMinutes
  const weekday = weekdayOf(input.dayFrame.date)

  const todaysCatalog = input.catalog.filter(
    (a) => a.enabled && a.allowedDays.includes(weekday)
  )

  // Phase 1a: FixedRule activities, placed at their declared times.
  const fixedSet = todaysCatalog.filter(hasFixed)
  const fixedOutcome = placeFixedSet(fixedSet, input.dayFrame, freezeBoundary)
  const occupiedAfterFixed: Interval[] = [
    ...fixedOutcome.placements.values(),
  ].map((p) => ({ start: p.start, end: p.end }))

  // Phase 1b: the remaining hard set — MandatoryRule without a FixedRule —
  // most-constrained first, with bounded backtracking.
  const mandatorySet = todaysCatalog.filter(
    (a) => hasMandatory(a) && !hasFixed(a)
  )
  const hardOutcome = placeHardSet(mandatorySet, occupiedAfterFixed, {
    freezeBoundary,
    grid,
    lengthMinutes,
    nodeLimit,
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
  const discretionary = todaysCatalog.filter((a) => !hardSetIds.has(a.id))
  const greedyOutcome = placeGreedy(discretionary, occupiedAfterHardSet, {
    freezeBoundary,
    grid,
    lengthMinutes,
  })

  const instances = todaysCatalog.map((activity) => {
    const placement =
      fixedOutcome.placements.get(activity.id) ??
      hardOutcome.placements.get(activity.id) ??
      greedyOutcome.placements.get(activity.id) ??
      null
    const skipReason =
      fixedOutcome.skipped.get(activity.id) ??
      hardOutcome.skipped.get(activity.id) ??
      greedyOutcome.skipped.get(activity.id) ??
      null
    return freshInstance(activity, input.dayFrame, placement, skipReason)
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

  const timeline: Timeline = {
    dayFrame: input.dayFrame,
    revision: 1,
    instances,
    diagnostics,
    cost: ZERO_COST,
    status,
    solvedAtOffset: input.now,
    finalised: false,
  }

  return {
    status,
    timeline,
    rejection: null,
    diagnostics,
    cost: ZERO_COST,
    trace: null,
  }
}
