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
 * Every legal placement of `activity` inside `context`, earliest first
 * (Section 7.6 tie-break #1). Duration and priority only so far — window,
 * shrink, and overlap feasibility land with their own rule types.
 */
export function enumerateFeasiblePlacements(
  activity: Activity,
  context: PlacementContext
): Placement[] {
  const starts = enumerateCandidateStarts(
    activity.durationMinutes,
    context.freeIntervals,
    context.grid
  ).filter((s) => s >= context.freezeBoundary)

  return starts.map((start) => ({
    start,
    end: start + activity.durationMinutes,
    nestedIn: null,
  }))
}

/** Single-activity placement search (SPEC.md Section 8.6): the cheapest candidate. */
export function placeActivity(
  activity: Activity,
  context: PlacementContext
): PlacementResult {
  const candidates = enumerateFeasiblePlacements(activity, context)
  if (candidates.length === 0) {
    return { placement: null, skipReason: "NO_FREE_SPACE" }
  }
  return { placement: candidates[0], skipReason: null }
}
