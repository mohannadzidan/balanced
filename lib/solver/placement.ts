/**
 * Placement strategies for the daily generator (PRD §2). Pure — the caller
 * is responsible for turning a returned `TimeRange` into a persisted row.
 */

import { type TimeRange } from "@/lib/time"
import { gapsWithinWindow } from "@/lib/solver/gaps"

export type FlexiblePlacement = {
  block: TimeRange
  /** True if there wasn't room for the full `durationMin` and the block was shrunk to fit. */
  wasShrunk: boolean
}

/**
 * Best-effort placement of a single flexible (non-tracked) activity's
 * `durationMin`-long block somewhere inside `window`'s bounds — preferring
 * to sit at the window's own start, but sliding later within whichever free
 * gap can hold it. `durationMin` may be shorter than the window's own span
 * (a floating block within wider bounds).
 *
 * Every non-transition activity is meant to show up on the timeline (PRD
 * §3.4 — nothing is silently dropped), so if nothing inside the window can
 * hold the full duration, this shrinks to the largest gap that overlaps the
 * window instead of skipping the activity outright. Only returns `null`
 * when the window has zero free overlap at all — everything inside it is
 * already occupied by higher-priority blocks.
 */
export function placeFlexibleBlock(
  window: TimeRange,
  durationMin: number,
  gaps: TimeRange[]
): FlexiblePlacement | null {
  if (durationMin <= 0) return null

  const candidates = gapsWithinWindow(gaps, window)
  if (candidates.length === 0) return null

  for (const gap of candidates) {
    const gapDuration = gap.endMin - gap.startMin
    if (gapDuration < durationMin) continue

    // Prefer sitting exactly at the window's own start when the gap allows it.
    const startMin = Math.max(
      gap.startMin,
      Math.min(window.startMin, gap.endMin - durationMin)
    )
    return {
      block: { startMin, endMin: startMin + durationMin },
      wasShrunk: false,
    }
  }

  const largest = candidates.reduce((best, gap) =>
    gap.endMin - gap.startMin > best.endMin - best.startMin ? gap : best
  )
  return { block: largest, wasShrunk: true }
}

export type TrackedFillResult = {
  placements: TimeRange[]
  /** Minutes of the target that couldn't be placed anywhere. */
  shortfallMin: number
}

/**
 * Greedily fills gaps (chronological order, clipped to `window` when given)
 * with blocks for a tracked activity until `targetMin` is met or no gap of
 * at least `minBlockMin` remains. A partially-used gap is split so later
 * activities can still use what's left of it — the returned `placements`
 * do not double-book any minute the caller previously marked occupied.
 */
export function fillTrackedActivity(input: {
  targetMin: number
  minBlockMin: number
  window: TimeRange | null
  gaps: TimeRange[]
}): TrackedFillResult {
  const eligible = gapsWithinWindow(input.gaps, input.window)
    .filter((gap) => gap.endMin - gap.startMin >= input.minBlockMin)
    .sort((a, b) => a.startMin - b.startMin)

  const placements: TimeRange[] = []
  let remaining = input.targetMin

  for (const gap of eligible) {
    if (remaining <= 0) break
    const gapDuration = gap.endMin - gap.startMin
    const blockDuration = Math.min(remaining, gapDuration)
    if (blockDuration < input.minBlockMin) continue

    placements.push({
      startMin: gap.startMin,
      endMin: gap.startMin + blockDuration,
    })
    remaining -= blockDuration
  }

  return { placements, shortfallMin: Math.max(0, remaining) }
}
