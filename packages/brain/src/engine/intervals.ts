import type { Interval } from "./types"

/** Maximal free intervals of [from, to) not covered by any occupied interval. */
export function computeFreeIntervals(
  occupied: readonly Interval[],
  from: number,
  to: number
): Interval[] {
  if (to <= from) return []

  const clipped = occupied
    .filter((iv) => iv.end > from && iv.start < to)
    .map((iv) => ({
      start: Math.max(iv.start, from),
      end: Math.min(iv.end, to),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const merged: Interval[] = []
  for (const iv of clipped) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end) {
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, iv.end),
      }
    } else {
      merged.push(iv)
    }
  }

  const free: Interval[] = []
  let cursor = from
  for (const iv of merged) {
    if (iv.start > cursor) free.push({ start: cursor, end: iv.start })
    cursor = iv.end
  }
  if (cursor < to) free.push({ start: cursor, end: to })
  return free
}

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

export function intervalContains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end
}

export function intervalLength(iv: Interval): number {
  return iv.end - iv.start
}

/** The portion of `base` not covered by any interval in `subtract`. */
export function subtractIntervals(
  base: Interval,
  subtract: readonly Interval[]
): Interval[] {
  return computeFreeIntervals(subtract, base.start, base.end)
}
