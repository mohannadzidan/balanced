import { placementCost } from "./cost"
import {
  enumerateCandidateStarts,
  placeActivityWithFloor,
  type PlacementContext,
} from "./placement"
import { evaluateCandidate } from "./resolve"
import type { ResolvedActivity } from "./resolve"
import type { Interval, Placement, ShrinkRule, SkipReason } from "./types"

export interface ChunkPlan {
  readonly chunks: readonly Placement[]
  readonly scheduledMinutes: number
  readonly cost: number
}

interface ChunkCandidate {
  readonly placement: Placement
  readonly driftMinutes: number
}

/** The lowest-drift legal placement of `length` minutes inside one interval. */
function bestChunkInInterval(
  resolved: ResolvedActivity,
  interval: Interval,
  length: number,
  context: PlacementContext
): ChunkCandidate | null {
  if (length <= 0) return null
  const starts = enumerateCandidateStarts(
    length,
    [interval],
    context.grid
  ).filter((s) => s >= context.freezeBoundary)

  let best: ChunkCandidate | null = null
  for (const start of starts) {
    const end = start + length
    const verdict = evaluateCandidate(resolved, start, end)
    if (!verdict.feasible) continue
    if (!best || verdict.driftMinutes < best.driftMinutes) {
      best = {
        placement: { start, end, nestedIn: null },
        driftMinutes: verdict.driftMinutes,
      }
    }
  }
  return best
}

/**
 * Clips free intervals to the outer bound a window rule allows (SPEC.md
 * Section 5.3): a StrictWindowRule permits nothing outside it; a
 * FlexibleWindowRule extends that bound by its drift allowance on each
 * side. Without either, every free interval is already in bounds.
 *
 * Chunk regions are ranked by a single guessed length per interval (see
 * `fillChunks`), which only works if that guess is drawn from the window's
 * own span — an unclipped multi-hour free interval would otherwise hide a
 * window-sized sub-region inside it entirely.
 */
function clipToWindowBounds(
  freeIntervals: readonly Interval[],
  resolved: ResolvedActivity
): Interval[] {
  const { strictWindow, flexibleWindow } = resolved
  const bound = strictWindow
    ? strictWindow
    : flexibleWindow
      ? {
          start: flexibleWindow.start - flexibleWindow.maxDriftMinutes,
          end: flexibleWindow.end + flexibleWindow.maxDriftMinutes,
        }
      : null
  if (!bound) return [...freeIntervals]

  const clipped: Interval[] = []
  for (const iv of freeIntervals) {
    const start = Math.max(iv.start, bound.start)
    const end = Math.min(iv.end, bound.end)
    if (start < end) clipped.push({ start, end })
  }
  return clipped
}

/**
 * One chunk plan for a specific chunk count `k` (SPEC.md Section 8.6 step
 * 5): rank free intervals by their cheapest (lowest-drift) candidate, then
 * greedily fill the `k` cheapest with segments of at least `minChunk`,
 * largest region first, until `target` total minutes is reached.
 */
function fillChunks(
  resolved: ResolvedActivity,
  freeIntervals: readonly Interval[],
  target: number,
  k: number,
  minChunk: number,
  context: PlacementContext
): ChunkPlan | null {
  interface Region {
    readonly interval: Interval
    readonly usable: number
    readonly driftMinutes: number
  }

  const regions: Region[] = []
  for (const iv of freeIntervals) {
    const usable = Math.min(
      Math.floor((iv.end - iv.start) / context.grid) * context.grid,
      target
    )
    if (usable < minChunk) continue
    const candidate = bestChunkInInterval(resolved, iv, usable, context)
    if (!candidate) continue
    regions.push({ interval: iv, usable, driftMinutes: candidate.driftMinutes })
  }

  regions.sort(
    (a, b) =>
      a.driftMinutes - b.driftMinutes ||
      b.usable - a.usable ||
      a.interval.start - b.interval.start
  )
  const selected = regions.slice(0, k)

  let remaining = target
  const chunks: Placement[] = []
  let totalDrift = 0
  for (const region of selected) {
    if (remaining <= 0) break
    const length = Math.min(remaining, region.usable)
    if (length < minChunk) return null
    const placed = bestChunkInInterval(
      resolved,
      region.interval,
      length,
      context
    )
    if (!placed) return null
    chunks.push(placed.placement)
    totalDrift += placed.driftMinutes
    remaining -= length
  }
  if (remaining > 0 || chunks.length === 0) return null

  const scheduledMinutes = chunks.reduce((s, c) => s + (c.end - c.start), 0)
  const cost = placementCost(
    resolved.activity.durationMinutes,
    context.weight,
    {
      scheduledMinutes,
      chunkCount: chunks.length,
      driftMinutes: totalDrift,
      gapMinutes: 0,
    },
    context.constants
  )
  return { chunks, scheduledMinutes, cost }
}

/**
 * Best chunked alternative across chunk counts 2..max_chunks (SPEC.md
 * Section 8.6 step 5). `null` if chunking is not allowed or no chunk count
 * can reach the full duration.
 */
export function planChunks(
  resolved: ResolvedActivity,
  shrinkRule: ShrinkRule,
  context: PlacementContext
): ChunkPlan | null {
  if (!shrinkRule.chunkingAllowed) return null
  const target = resolved.activity.durationMinutes
  const searchIntervals = clipToWindowBounds(context.freeIntervals, resolved)

  let best: ChunkPlan | null = null
  for (let k = 2; k <= shrinkRule.maxChunks; k++) {
    const plan = fillChunks(
      resolved,
      searchIntervals,
      target,
      k,
      shrinkRule.minChunkMinutes,
      context
    )
    if (plan && (!best || plan.cost < best.cost)) best = plan
  }
  return best
}

export interface ShrinkOutcome {
  readonly placement: Placement | null
  readonly chunks: readonly Placement[] | null
  readonly scheduledMinutes: number
  readonly skipReason: SkipReason | null
}

/**
 * Full single-activity placement search including a ShrinkRule's shrink and
 * chunk alternatives (SPEC.md Section 8.6 steps 2, 4 and 5): the cheapest of
 * the best single-block candidate (shrunk if needed) and the best chunk
 * plan wins; a whole unsplit block at full duration remains the zero-cost
 * baseline since it always survives as a single-block candidate.
 */
export function placeWithShrinkRule(
  resolved: ResolvedActivity,
  shrinkRule: ShrinkRule | null,
  context: PlacementContext
): ShrinkOutcome {
  const floor = shrinkRule
    ? shrinkRule.minDurationMinutes
    : resolved.activity.durationMinutes
  const single = placeActivityWithFloor(resolved, floor, context)
  const chunkPlan = shrinkRule?.chunkingAllowed
    ? planChunks(resolved, shrinkRule, context)
    : null

  if (chunkPlan && (!single.placement || chunkPlan.cost < single.cost)) {
    return {
      placement: null,
      chunks: chunkPlan.chunks,
      scheduledMinutes: chunkPlan.scheduledMinutes,
      skipReason: null,
    }
  }
  if (single.placement) {
    return {
      placement: single.placement,
      chunks: null,
      scheduledMinutes: single.scheduledMinutes,
      skipReason: null,
    }
  }
  return {
    placement: null,
    chunks: null,
    scheduledMinutes: 0,
    skipReason: single.skipReason,
  }
}
