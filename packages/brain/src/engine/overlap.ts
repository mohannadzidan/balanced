import { computeFreeIntervals } from "./intervals";
import { enumerateFeasiblePlacementsForLength, type PlacementContext } from "./placement";
import type { ResolvedActivity } from "./resolve";
import { resolveWallClock } from "./time";
import type {
  Activity,
  DayFrame,
  ExclusionWindow,
  Interval,
  OverlapRule,
  Placement,
} from "./types";

export function overlapRuleOf(activity: Activity): OverlapRule | null {
  return activity.rules.find((r): r is OverlapRule => r.type === "overlap") ?? null;
}

/** Resolves one ExclusionWindow to offsets in `dayFrame` (SPEC.md Section 5.7).
 * `dayIndex` selects which calendar day's wall-clock offsets absolute
 * exclusions resolve against (SPEC-v2.1 §7.4 — absolute exclusions resolve
 * per day, scoped to the host occurrence's bucket). For relative-anchored
 * exclusions the parameter is ignored: those windows move with their host. */
export function resolveExclusionWindow(
  window: ExclusionWindow,
  host: { readonly start: number },
  dayFrame: DayFrame,
  dayIndex = 0,
): Interval {
  if (window.anchor === "relative") {
    return {
      start: host.start + (window.startOffset ?? 0),
      end: host.start + (window.endOffset ?? 0),
    };
  }
  return {
    start: resolveWallClock(window.startWall ?? "00:00", dayFrame, dayIndex),
    end: resolveWallClock(window.endWall ?? "00:00", dayFrame, dayIndex),
  };
}

/**
 * Absolute-anchored exclusion windows, resolved once per host occurrence's
 * own day (SPEC-v2.1 §7.4). With `dayIndex = 0` (the default), the function
 * reproduces v1's "resolve once against day 0" behavior bit-for-bit — every
 * existing call site continues to work unchanged. A multi-day-frame caller
 * passes the host occurrence's own bucket dayIndex so the window falls on
 * the correct calendar day rather than always on day 0.
 */
export function resolveAbsoluteExclusions(
  rule: OverlapRule | null,
  dayFrame: DayFrame,
  dayIndex = 0,
): Interval[] {
  if (!rule) return [];
  return rule.exclusionWindows
    .filter((w) => w.anchor === "absolute")
    .map((w) => resolveExclusionWindow(w, { start: 0 }, dayFrame, dayIndex));
}

/**
 * The host's span minus its exclusion windows minus its already-nested
 * guests (SPEC.md Section 8.6 step 1). Budget is enforced separately, by
 * capping the candidate guest's own length — it doesn't change the region's
 * shape.
 */
export function computeNestableRegions(
  host: { readonly start: number; readonly end: number },
  rule: OverlapRule,
  existingGuests: readonly Placement[],
  dayFrame: DayFrame,
): Interval[] {
  const occupied: Interval[] = [
    ...rule.exclusionWindows.map((w) => resolveExclusionWindow(w, host, dayFrame)),
    ...existingGuests.map((g) => ({ start: g.start, end: g.end })),
  ];
  return computeFreeIntervals(occupied, host.start, host.end);
}

/** Total minutes already drawn from the host's shared overlap budget. */
export function usedBudget(existingGuests: readonly Placement[]): number {
  return existingGuests.reduce((sum, g) => sum + (g.end - g.start), 0);
}

export interface NestedSearchResult {
  readonly placement: Placement;
  readonly cost: number;
  readonly scheduledMinutes: number;
}

/**
 * The cheapest legal nested placement of a guest inside one already-placed
 * host (SPEC.md Section 8.6 step 1 and Section 5.7): searches a shrink
 * ladder from the full duration (capped by the host's remaining budget)
 * down to `shrinkFloor`, over the host's nestable regions. `null` if the
 * budget is already exhausted, the floor can't fit inside it, or no region
 * has room. Scoped to single-block guests — a guest with its own chunking
 * ShrinkRule is not split across a host's nestable regions.
 */
export function findBestNestedPlacement(
  resolved: ResolvedActivity,
  shrinkFloor: number,
  hostPlacement: { readonly start: number; readonly end: number },
  overlapRule: OverlapRule,
  existingGuests: readonly Placement[],
  dayFrame: DayFrame,
  context: PlacementContext,
): NestedSearchResult | null {
  const remainingBudget = overlapRule.budgetMinutes - usedBudget(existingGuests);
  if (remainingBudget <= 0) return null;

  const fullLength = resolved.activity.durationMinutes;
  const cappedFull = Math.min(fullLength, remainingBudget);
  if (cappedFull < shrinkFloor) return null;

  const region = computeNestableRegions(hostPlacement, overlapRule, existingGuests, dayFrame);

  let best: NestedSearchResult | null = null;
  for (let length = cappedFull; length >= shrinkFloor; length -= context.grid) {
    const ranked = enumerateFeasiblePlacementsForLength(resolved, length, {
      ...context,
      freeIntervals: region,
    });
    if (ranked.length === 0) continue;
    const top = ranked[0];
    if (!best || top.cost < best.cost) {
      best = {
        placement: top.placement,
        cost: top.cost,
        scheduledMinutes: length,
      };
    }
  }
  return best;
}
