import { computeFreeIntervals } from "./intervals"
import { placeActivity } from "./placement"
import type { Activity, Interval, Placement, SkipReason } from "./types"

export interface GreedyContext {
  readonly freezeBoundary: number
  readonly grid: number
  readonly lengthMinutes: number
}

export interface GreedyOutcome {
  readonly placements: ReadonlyMap<string, Placement>
  readonly skipped: ReadonlyMap<string, SkipReason>
}

/**
 * Phase 2 (SPEC.md Section 8.5): process the remaining candidates in
 * ascending priority rank, accepting the best placement for each against a
 * day already populated by hard-set placements and higher-priority peers.
 * No backtracking — anything already placed outranks whatever comes next.
 */
export function placeGreedy(
  candidates: readonly Activity[],
  baseOccupied: readonly Interval[],
  ctx: GreedyContext
): GreedyOutcome {
  const placements = new Map<string, Placement>()
  const skipped = new Map<string, SkipReason>()
  const occupied: Interval[] = [...baseOccupied]

  const ordered = [...candidates].sort(
    (a, b) => a.priorityRank - b.priorityRank
  )
  for (const activity of ordered) {
    const freeIntervals = computeFreeIntervals(
      occupied,
      ctx.freezeBoundary,
      ctx.lengthMinutes
    )
    const result = placeActivity(activity, {
      freeIntervals,
      freezeBoundary: ctx.freezeBoundary,
      grid: ctx.grid,
      lengthMinutes: ctx.lengthMinutes,
    })
    if (result.placement) {
      placements.set(activity.id, result.placement)
      occupied.push({
        start: result.placement.start,
        end: result.placement.end,
      })
    } else if (result.skipReason) {
      skipped.set(activity.id, result.skipReason)
    }
  }

  return { placements, skipped }
}
