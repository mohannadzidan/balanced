/**
 * Free-gap arithmetic for the daily generator (PRD §2). Pure — never touches
 * the database. Operates in minutes-from-midnight over a single calendar
 * day; a strict block that spans midnight is clamped to `dayEnd` here since
 * only *today's* occupied minutes matter for filling *today's* gaps (the
 * overnight remainder is Phase 09's concern).
 */

import { type TimeRange } from "@/lib/time"

/** The free ranges left in `[dayStart, dayEnd)` once `occupied` is carved out. */
export function freeGaps(occupied: TimeRange[], dayStart = 0, dayEnd = 1440): TimeRange[] {
  const sorted = [...occupied]
    .map((range) => ({
      startMin: Math.max(dayStart, Math.min(range.startMin, dayEnd)),
      endMin: Math.max(dayStart, Math.min(range.endMin, dayEnd)),
    }))
    .filter((range) => range.endMin > range.startMin)
    .sort((a, b) => a.startMin - b.startMin)

  const gaps: TimeRange[] = []
  let cursor = dayStart
  for (const range of sorted) {
    if (range.startMin > cursor) {
      gaps.push({ startMin: cursor, endMin: range.startMin })
    }
    cursor = Math.max(cursor, range.endMin)
  }
  if (cursor < dayEnd) {
    gaps.push({ startMin: cursor, endMin: dayEnd })
  }
  return gaps
}

/** The overlap of two ranges, or `null` if they don't intersect. */
export function intersectRange(a: TimeRange, b: TimeRange): TimeRange | null {
  const startMin = Math.max(a.startMin, b.startMin)
  const endMin = Math.min(a.endMin, b.endMin)
  return endMin > startMin ? { startMin, endMin } : null
}

/** Gaps clipped to the portions that fall inside `window` (unrestricted if `window` is `null`). */
export function gapsWithinWindow(gaps: TimeRange[], window: TimeRange | null): TimeRange[] {
  if (window === null) return gaps
  return gaps
    .map((gap) => intersectRange(gap, window))
    .filter((range): range is TimeRange => range !== null)
}
