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
  /**
   * Absolute-anchored OverlapRule exclusion windows on this activity, if it
   * is a host (SPEC.md Section 5.7): a hard constraint that each candidate
   * must fully contain every one of these windows.
   */
  readonly absoluteExclusions?: readonly Interval[]
  /**
   * SPEC-v2.1 §6.1: when this occurrence has already-placed siblings,
   * `minSeparationMinutes` rejects any candidate start within that window
   * of any sibling's start (start-to-start). Unset / 0 disables the
   * filter — the existing single-occurrence path is unchanged.
   */
  readonly minSeparationMinutes?: number
  /** SPEC-v2.1 §6.1: sibling starts to keep `minSeparationMinutes` clear of. */
  readonly siblingStarts?: readonly number[]
}

/**
 * SPEC-v2.1 §6.1: pure start-to-start separation filter. Discard any
 * candidate start within `minSeparationMinutes` of an already-placed
 * sibling's start. Feasibility-only — never a cost term (§6.1: "Separation
 * is feasibility, never cost") — which keeps every cost local to the
 * candidate and lets greedy-earliest fall out cleanly across siblings.
 */
export function violatesSeparation(
  start: number,
  minSeparationMinutes: number,
  siblingStarts: readonly number[] | undefined
): boolean {
  if (
    minSeparationMinutes <= 0 ||
    !siblingStarts ||
    siblingStarts.length === 0
  ) {
    return false
  }
  for (const s of siblingStarts) {
    if (Math.abs(start - s) < minSeparationMinutes) return true
  }
  return false
}

function containsAllExclusions(
  exclusions: readonly Interval[] | undefined,
  start: number,
  end: number
): boolean {
  if (!exclusions) return true
  return exclusions.every((w) => w.start >= start && w.end <= end)
}

export interface PlacementResult {
  readonly placement: Placement | null
  readonly skipReason: SkipReason | null
}

export interface ShrinkPlacementResult extends PlacementResult {
  readonly scheduledMinutes: number
  readonly cost: number
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
 * Every legal placement of `activity` at a given `length` inside `context`,
 * cheapest first, per the Section 7.6 tie-break chain. `length` may be less
 * than the activity's full duration when searching a ShrinkRule's ladder —
 * the returned cost is priced against the full duration (SPEC.md Section
 * 7.3's shrink term), not `length`.
 */
export function enumerateFeasiblePlacementsForLength(
  resolved: ResolvedActivity,
  length: number,
  context: PlacementContext
): { placement: Placement; cost: number }[] {
  const { activity } = resolved
  const starts = enumerateCandidateStarts(
    length,
    context.freeIntervals,
    context.grid
  )
    .filter((s) => s >= context.freezeBoundary)
    .filter(
      (s) =>
        !violatesSeparation(
          s,
          context.minSeparationMinutes ?? 0,
          context.siblingStarts
        )
    )

  const ranked: { placement: Placement; cost: number }[] = []
  for (const start of starts) {
    const end = start + length
    const verdict = evaluateCandidate(resolved, start, end)
    if (!verdict.feasible) continue
    if (!containsAllExclusions(context.absoluteExclusions, start, end)) continue

    const evaluation: CandidateEvaluation = {
      scheduledMinutes: length,
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

  return ranked
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
  return enumerateFeasiblePlacementsForLength(
    resolved,
    resolved.activity.durationMinutes,
    context
  ).map((r) => r.placement)
}

/**
 * Every legal placement across a ShrinkRule's ladder (full duration down to
 * `floorMinutes`), cheapest first. Used where a full candidate list — not
 * just the single best — is needed, e.g. hard-set backtracking. With no
 * ShrinkRule, `floorMinutes` equals the full duration and this is identical
 * to `enumerateFeasiblePlacements`.
 */
export function enumerateFeasiblePlacementsAcrossLengths(
  resolved: ResolvedActivity,
  floorMinutes: number,
  context: PlacementContext
): Placement[] {
  const fullLength = resolved.activity.durationMinutes
  const ranked: {
    placement: Placement
    cost: number
    scheduledMinutes: number
  }[] = []
  for (
    let length = fullLength;
    length >= floorMinutes;
    length -= context.grid
  ) {
    for (const r of enumerateFeasiblePlacementsForLength(
      resolved,
      length,
      context
    )) {
      ranked.push({ ...r, scheduledMinutes: length })
    }
  }
  ranked.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost
    if (a.scheduledMinutes !== b.scheduledMinutes) {
      return b.scheduledMinutes - a.scheduledMinutes
    }
    return a.placement.start - b.placement.start
  })
  return ranked.map((r) => r.placement)
}

function inferSkipReason(
  resolved: ResolvedActivity,
  floorMinutes: number,
  context: PlacementContext
): SkipReason {
  const rawStarts = enumerateCandidateStarts(
    floorMinutes,
    context.freeIntervals,
    context.grid
  ).filter((s) => s >= context.freezeBoundary)
  if (rawStarts.length === 0) return "NO_FREE_SPACE"
  if (resolved.windows.some((w) => w.maxDriftMinutes > 0))
    return "DRIFT_EXCEEDED"
  if (resolved.windows.length > 0) return "WINDOW_UNSATISFIABLE"
  return "NO_FREE_SPACE"
}

/** Single-activity placement search (SPEC.md Section 8.6): the cheapest candidate. */
export function placeActivity(
  resolved: ResolvedActivity,
  context: PlacementContext
): PlacementResult {
  const { placement, skipReason } = placeActivityWithFloor(
    resolved,
    resolved.activity.durationMinutes,
    context
  )
  return { placement, skipReason }
}

/**
 * Single-block placement search across a ShrinkRule's ladder (SPEC.md
 * Section 8.6 steps 2 and 4): tries every length from the full duration down
 * to `floorMinutes` in `GRID` steps and returns the globally cheapest
 * candidate. With no ShrinkRule, `floorMinutes` equals the full duration and
 * this is identical to `placeActivity`.
 */
export function placeActivityWithFloor(
  resolved: ResolvedActivity,
  floorMinutes: number,
  context: PlacementContext
): ShrinkPlacementResult {
  const fullLength = resolved.activity.durationMinutes
  let best: {
    placement: Placement
    cost: number
    scheduledMinutes: number
  } | null = null

  for (
    let length = fullLength;
    length >= floorMinutes;
    length -= context.grid
  ) {
    const ranked = enumerateFeasiblePlacementsForLength(
      resolved,
      length,
      context
    )
    if (ranked.length === 0) continue
    const top = ranked[0]
    if (!best || top.cost < best.cost) {
      best = {
        placement: top.placement,
        cost: top.cost,
        scheduledMinutes: length,
      }
    }
  }

  if (best) {
    return {
      placement: best.placement,
      skipReason: null,
      scheduledMinutes: best.scheduledMinutes,
      cost: best.cost,
    }
  }

  return {
    placement: null,
    skipReason: inferSkipReason(resolved, floorMinutes, context),
    scheduledMinutes: 0,
    cost: Number.POSITIVE_INFINITY,
  }
}
