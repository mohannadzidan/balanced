import { resolveWallClock } from "./time"
import type { Activity, DayFrame } from "./types"

export interface CandidateVerdict {
  readonly feasible: boolean
  readonly driftMinutes: number
}

export interface ResolvedWindow {
  readonly start: number
  readonly end: number
}

export interface ResolvedFlexibleWindow extends ResolvedWindow {
  readonly maxDriftMinutes: number
}

/** An activity's wall-clock rules resolved to numeric offsets for one DayFrame. */
export interface ResolvedActivity {
  readonly activity: Activity
  readonly strictWindow: ResolvedWindow | null
  readonly flexibleWindow: ResolvedFlexibleWindow | null
}

/** Phase 0, step 7 (SPEC.md Section 8.3): resolve wall-clock rules to offsets. */
export function resolveActivity(
  activity: Activity,
  dayFrame: DayFrame
): ResolvedActivity {
  const strictRule = activity.rules.find((r) => r.type === "strictWindow")
  const flexibleRule = activity.rules.find((r) => r.type === "flexibleWindow")

  return {
    activity,
    strictWindow: strictRule
      ? {
          start: resolveWallClock(strictRule.startWall, dayFrame),
          end: resolveWallClock(strictRule.endWall, dayFrame),
        }
      : null,
    flexibleWindow: flexibleRule
      ? {
          start: resolveWallClock(flexibleRule.startWall, dayFrame),
          end: resolveWallClock(flexibleRule.endWall, dayFrame),
          maxDriftMinutes: flexibleRule.maxDriftMinutes,
        }
      : null,
  }
}

/**
 * Window feasibility for one candidate (SPEC.md Section 8.6 step 3 and
 * Section 5.3's drift table). A StrictWindowRule requires full containment;
 * a FlexibleWindowRule allows drift up to its allowance. An activity with
 * neither is unconstrained.
 */
export function evaluateCandidate(
  resolved: ResolvedActivity,
  start: number,
  end: number
): CandidateVerdict {
  const { strictWindow, flexibleWindow } = resolved

  if (strictWindow) {
    return {
      feasible: start >= strictWindow.start && end <= strictWindow.end,
      driftMinutes: 0,
    }
  }

  if (flexibleWindow) {
    // Minutes of the activity before the window start, and after the window
    // end — each capped against the other bound so a candidate entirely on
    // one side isn't double-counted past its own duration.
    const before = Math.max(0, Math.min(end, flexibleWindow.start) - start)
    const after = Math.max(0, end - Math.max(start, flexibleWindow.end))
    const driftMinutes = before + after
    return {
      feasible: driftMinutes <= flexibleWindow.maxDriftMinutes,
      driftMinutes,
    }
  }

  return { feasible: true, driftMinutes: 0 }
}
