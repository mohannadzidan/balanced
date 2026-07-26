import { resolveWallClock } from "./time"
import type { Activity, DayFrame } from "./types"

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
