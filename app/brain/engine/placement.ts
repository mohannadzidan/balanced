import { placementCost, type CandidateEvaluation } from "./cost"
import type { ResolvedActivity } from "./resolve"
import type { CostConstants, Interval, Placement, SkipReason } from "./types"

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

export interface CandidateVerdict {
  readonly feasible: boolean
  readonly driftMinutes: number
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
