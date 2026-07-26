import type { Activity, Interval, Placement, SkipReason } from "./types"

export interface PlacementContext {
  readonly freeIntervals: readonly Interval[]
  readonly freezeBoundary: number
  readonly grid: number
  readonly lengthMinutes: number
}

export interface PlacementResult {
  readonly placement: Placement | null
  readonly skipReason: SkipReason | null
}

/** Every grid-aligned start inside `freeIntervals` that fits `durationMinutes`. */
export function enumerateCandidateStarts(
  durationMinutes: number,
  freeIntervals: readonly Interval[],
  grid: number
): number[] {
  const starts: number[] = []
  for (const iv of freeIntervals) {
    const firstGridStart = Math.ceil(iv.start / grid) * grid
    for (let s = firstGridStart; s + durationMinutes <= iv.end; s += grid) {
      starts.push(s)
    }
  }
  return starts
}

/**
 * Single-activity placement search (SPEC.md Section 8.6), v0: duration and
 * priority only — no rule-specific feasibility or cost yet. Picks the
 * earliest legal start, per the Section 7.6 tie-break chain.
 */
export function placeActivity(
  activity: Activity,
  context: PlacementContext
): PlacementResult {
  const starts = enumerateCandidateStarts(
    activity.durationMinutes,
    context.freeIntervals,
    context.grid
  ).filter((s) => s >= context.freezeBoundary)

  if (starts.length === 0) {
    return { placement: null, skipReason: "NO_FREE_SPACE" }
  }

  const start = starts[0]
  return {
    placement: {
      start,
      end: start + activity.durationMinutes,
      nestedIn: null,
    },
    skipReason: null,
  }
}
