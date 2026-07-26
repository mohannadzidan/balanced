import { computeFreeIntervals } from "./intervals"
import { placeActivity } from "./placement"
import { weekdayOf } from "./time"
import type {
  Activity,
  CostBreakdown,
  DayFrame,
  Interval,
  Placement,
  SkipReason,
  SolveInput,
  SolveResult,
  Timeline,
  TimelineActivity,
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
 * Engine build step 2–3 (SPEC.md Section 16): greedy placement by priority
 * rank only, `GENERATE_DAY` only. Rules, cost, and the remaining event
 * types are added in later build steps.
 */
export function solve(input: SolveInput): SolveResult {
  const grid = input.constants?.GRID ?? 5
  const weekday = weekdayOf(input.dayFrame.date)
  const candidates = input.catalog.filter(
    (a) => a.enabled && a.allowedDays.includes(weekday)
  )
  const ordered = [...candidates].sort(
    (a, b) => a.priorityRank - b.priorityRank
  )

  const occupied: Interval[] = []
  const instances: TimelineActivity[] = []

  for (const activity of ordered) {
    const freeIntervals = computeFreeIntervals(
      occupied,
      input.now,
      input.dayFrame.lengthMinutes
    )
    const result = placeActivity(activity, {
      freeIntervals,
      freezeBoundary: input.now,
      grid,
      lengthMinutes: input.dayFrame.lengthMinutes,
    })
    instances.push(
      freshInstance(
        activity,
        input.dayFrame,
        result.placement,
        result.skipReason
      )
    )
    if (result.placement) {
      occupied.push({
        start: result.placement.start,
        end: result.placement.end,
      })
    }
  }

  const timeline: Timeline = {
    dayFrame: input.dayFrame,
    revision: 1,
    instances,
    diagnostics: [],
    cost: ZERO_COST,
    status: "OK",
    solvedAtOffset: input.now,
    finalised: false,
  }

  return {
    status: "OK",
    timeline,
    rejection: null,
    diagnostics: [],
    cost: ZERO_COST,
    trace: null,
  }
}
