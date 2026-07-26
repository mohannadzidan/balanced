import { placementCost, type CandidateEvaluation } from "./cost"
import { evaluateCandidate } from "./resolve"
import type { ResolvedActivity } from "./resolve"
import type { CostConstants, Interval, Placement, SkipReason } from "./types"

export { evaluateCandidate }
export type { CandidateVerdict } from "./resolve"

export interface PlacementContext {
  readonly freeIntervals: readonly Interval[]
  readonly freezeBoundary: number
  readonly grid: number
  readonly lengthMinutes: number
  readonly weight: number
  readonly constants: CostConstants
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
 * Every legal placement of `activity` inside `context`, cheapest first, per
 * the Section 7.6 tie-break chain (earliest start is still the only
 * meaningful tie-break until shrink/chunk exist).
 */
export function enumerateFeasiblePlacements(
  resolved: ResolvedActivity,
  context: PlacementContext
): Placement[] {
  const { activity } = resolved
  const starts = enumerateCandidateStarts(
    activity.durationMinutes,
    context.freeIntervals,
    context.grid
  ).filter((s) => s >= context.freezeBoundary)

  const ranked: { placement: Placement; cost: number }[] = []
  for (const start of starts) {
    const end = start + activity.durationMinutes
    const verdict = evaluateCandidate(resolved, start, end)
    if (!verdict.feasible) continue

    const evaluation: CandidateEvaluation = {
      scheduledMinutes: activity.durationMinutes,
      chunkCount: 1,
      driftMinutes: verdict.driftMinutes,
      gapMinutes: 0,
    }
    const cost = placementCost(
      activity.durationMinutes,
      context.weight,
      evaluation,
      context.constants
    )
    ranked.push({ placement: { start, end, nestedIn: null }, cost })
  }

  ranked.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost
    return a.placement.start - b.placement.start
  })

  return ranked.map((r) => r.placement)
}

/** Single-activity placement search (SPEC.md Section 8.6): the cheapest candidate. */
export function placeActivity(
  resolved: ResolvedActivity,
  context: PlacementContext
): PlacementResult {
  const rawStarts = enumerateCandidateStarts(
    resolved.activity.durationMinutes,
    context.freeIntervals,
    context.grid
  ).filter((s) => s >= context.freezeBoundary)

  if (rawStarts.length === 0) {
    return { placement: null, skipReason: "NO_FREE_SPACE" }
  }

  const candidates = enumerateFeasiblePlacements(resolved, context)
  if (candidates.length === 0) {
    const reason: SkipReason = resolved.flexibleWindow
      ? "DRIFT_EXCEEDED"
      : resolved.strictWindow
        ? "WINDOW_UNSATISFIABLE"
        : "NO_FREE_SPACE"
    return { placement: null, skipReason: reason }
  }

  return { placement: candidates[0], skipReason: null }
}
