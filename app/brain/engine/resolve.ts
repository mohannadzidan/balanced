import { resolveWallClock } from "./time"
import type {
  Activity,
  DayFrame,
  Frame,
  OverlapRule,
  ResolvedWindow,
  SequenceRule,
  Weekday,
  WindowRule,
} from "./types"

export type { ResolvedWindow }

const ALL_WEEKDAYS: readonly Weekday[] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]

export interface CandidateVerdict {
  readonly feasible: boolean
  readonly driftMinutes: number
}

/** An activity's WindowRules resolved to numeric offsets for one DayFrame. */
export interface ResolvedActivity {
  readonly activity: Activity
  readonly windows: readonly ResolvedWindow[]
}

export function windowRulesOf(activity: Activity): readonly WindowRule[] {
  return activity.rules.filter((r): r is WindowRule => r.type === "window")
}

/**
 * The union of eligible weekdays across an activity's WindowRules
 * (SPEC-v2.md Section 4.1) — every weekday when no WindowRule is present at
 * all, since "allowedDays is a window, not a filter": a day not named by any
 * window is a day the activity cannot be placed on.
 */
export function eligibleWeekdaysOf(activity: Activity): ReadonlySet<Weekday> {
  const windows = windowRulesOf(activity)
  if (windows.length === 0) return new Set(ALL_WEEKDAYS)
  const days = new Set<Weekday>()
  for (const w of windows) for (const d of w.days) days.add(d)
  return days
}

export function isEligibleOnDay(activity: Activity, weekday: Weekday): boolean {
  return eligibleWeekdaysOf(activity).has(weekday)
}

/** Phase 0, step 7 (SPEC.md Section 8.3): resolve wall-clock rules to offsets. */
export function resolveActivity(
  activity: Activity,
  dayFrame: DayFrame
): ResolvedActivity {
  const day = dayFrame.days[0]
  const windows = windowRulesOf(activity).map((rule) => ({
    start: resolveWallClock(rule.startWall, dayFrame),
    end: resolveWallClock(rule.endWall, dayFrame),
    maxDriftMinutes: rule.maxDriftMinutes,
    dayIndex: 0,
    daySpanStart: day.startOffset,
    daySpanEnd: day.startOffset + day.lengthMinutes,
  }))
  return { activity, windows }
}

/**
 * SPEC-v2.1 §4: resolves an activity's WindowRules into one ResolvedWindow
 * per matching day in the frame (not per rule, as in Drop 1).
 *
 * For each WindowRule and each `frame.days[i]` whose weekday is in `rule.days`,
 * produces a {start, end, maxDriftMinutes, dayIndex} tuple. A spanning window
 * (endWall ≤ startWall) is resolved against the following day's own offset so
 * it becomes one contiguous interval crossing the day boundary.
 *
 * Returns an empty list for an activity with no WindowRule (Drop-1-compatible:
 * `windowRulesOf` returns [], so the activity has no eligible intervals).
 */
export function resolveWindows(
  activity: Activity,
  frame: Frame
): readonly ResolvedWindow[] {
  const rules = windowRulesOf(activity)
  if (rules.length === 0) return []

  const windows: ResolvedWindow[] = []
  for (const rule of rules) {
    for (const day of frame.days) {
      if (!rule.days.includes(day.weekday)) continue
      const start = resolveWallClock(rule.startWall, frame, day.index)
      // Spanning window: endWall ≤ startWall → resolve end against the next
      // day's offset so it becomes one contiguous interval.
      let end: number
      if (rule.endWall > rule.startWall) {
        end = resolveWallClock(rule.endWall, frame, day.index)
      } else {
        // Spanning: resolve end against the next day (or the last day itself
        // if there is no next). resolveWallClock already returns frame-relative
        // offset, so adding nextDay.startOffset would double-count.
        const nextDayIndex =
          day.index + 1 < frame.days.length ? day.index + 1 : day.index
        end = resolveWallClock(rule.endWall, frame, nextDayIndex)
      }
      // §4.1's eligible day span: this day's full extent, plus the next
      // day's too when the window spans midnight (its own `end` already
      // lies there) — the hard bound drift may soften a window against but
      // never cross.
      const spansMidnight = rule.endWall <= rule.startWall
      const daySpanStart = day.startOffset
      const daySpanEnd =
        spansMidnight && day.index + 1 < frame.days.length
          ? frame.days[day.index + 1].startOffset +
            frame.days[day.index + 1].lengthMinutes
          : day.startOffset + day.lengthMinutes
      windows.push({
        start,
        end,
        maxDriftMinutes: rule.maxDriftMinutes,
        dayIndex: day.index,
        daySpanStart,
        daySpanEnd,
      })
    }
  }
  return windows
}

/**
 * Window feasibility for one candidate (SPEC.md Section 8.6 step 3 and
 * Section 5.3's drift table; SPEC-v2.md Section 4.1's min-over-windows
 * merge). A strict window is a flexible window with zero drift — "placed
 * entirely inside the window" and "minutes outside the window <= 0" are the
 * same predicate, so no special-casing is needed. With more than one
 * WindowRule, drift is the minimum raw drift across all windows, and a
 * candidate is feasible iff at least one window's own drift clears its own
 * allowance. An activity with no WindowRule at all is unconstrained.
 *
 * SPEC-v2.1 §4's second conjunct: feasibility also requires the candidate
 * fall entirely within the union of every window's eligible day span. Drift
 * softens a *window*; it must never soften *day eligibility* — without this,
 * a generous drift allowance could place a candidate on a calendar day the
 * activity was never eligible for at all (e.g. drifting off Tuesday's
 * window onto Wednesday).
 */
export function evaluateCandidate(
  resolved: ResolvedActivity,
  start: number,
  end: number
): CandidateVerdict {
  const { windows } = resolved
  if (windows.length === 0) return { feasible: true, driftMinutes: 0 }

  let minDrift = Number.POSITIVE_INFINITY
  let driftFeasible = false
  for (const window of windows) {
    // Minutes of the activity before the window start, and after the window
    // end — each capped against the other bound so a candidate entirely on
    // one side isn't double-counted past its own duration.
    const before = Math.max(0, Math.min(end, window.start) - start)
    const after = Math.max(0, end - Math.max(start, window.end))
    const driftMinutes = before + after
    if (driftMinutes < minDrift) minDrift = driftMinutes
    if (driftMinutes <= window.maxDriftMinutes) driftFeasible = true
  }
  const feasible = driftFeasible && isContainedInEligibleDaySpan(windows, start, end)
  return { feasible, driftMinutes: minDrift }
}

/** The union of every window's `[daySpanStart, daySpanEnd)`, merged, checked
 * for full containment of `[start, end)` — SPEC-v2.1 §4's hard bound. */
function isContainedInEligibleDaySpan(
  windows: readonly ResolvedWindow[],
  start: number,
  end: number
): boolean {
  const spans = [...windows]
    .map((w) => ({ start: w.daySpanStart, end: w.daySpanEnd }))
    .sort((a, b) => a.start - b.start)

  const merged: { start: number; end: number }[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
    } else {
      merged.push({ ...span })
    }
  }
  return merged.some((m) => start >= m.start && end <= m.end)
}

/**
 * Whether `activity` may be expanded into one occurrence per eligible bucket
 * (SPEC-v2.1 §7). OverlapRule and SequenceRule cross-reference activities by
 * their real id (`allowedGuestIds`, `linkedActivityId`) — rekeying those per
 * occurrence is §7.3/§7.4's job (slices 3.6/3.7). Until then, any activity
 * that is a host, a guest, a sequence dependent, or a sequence host keeps its
 * current single-instance-per-frame behavior. FixedRule has no such
 * cross-reference (§7.1: `resolveFixedPlacement` now resolves against each
 * occurrence's own bucket day), so it no longer disqualifies ghosting.
 */
export function isGhostable(activity: Activity, catalog: readonly Activity[]): boolean {
  if (activity.rules.some((r) => r.type === "overlap" || r.type === "sequence")) {
    return false
  }
  for (const other of catalog) {
    const overlap = other.rules.find((r): r is OverlapRule => r.type === "overlap")
    if (overlap?.allowedGuestIds.includes(activity.id)) return false
    const sequence = other.rules.find((r): r is SequenceRule => r.type === "sequence")
    if (sequence?.linkedActivityId === activity.id) return false
  }
  return true
}
