import { computeFreeIntervals } from "./intervals";
import { findBestNestedPlacement, overlapRuleOf, resolveAbsoluteExclusions } from "./overlap";
import { placeWithElasticity } from "./shrink";
import type { ResolvedActivity } from "./resolve";
import type {
  Activity,
  CostConstants,
  DayFrame,
  ElasticityRule,
  Interval,
  Placement,
  RepeatRule,
  SkipReason,
} from "./types";

function elasticityRuleOf(activity: Activity): ElasticityRule | null {
  return activity.rules.find((r): r is ElasticityRule => r.type === "elasticity") ?? null;
}

// SPEC-v2.1 §5.4: an activity may carry a chunking RepeatRule (sharedBudget:
// true, feeds placeWithElasticity's chunk plan) and a recurrence RepeatRule
// (sharedBudget: false, feeds expand()'s bucketing) at once — only the
// chunking one is relevant here, so this must not just grab whichever
// RepeatRule happens to appear first in `rules`.
export function repeatRuleOf(activity: Activity): RepeatRule | null {
  return activity.rules.find((r): r is RepeatRule => r.type === "repeat" && r.sharedBudget) ?? null;
}

function elasticityFloorOf(activity: Activity): number {
  const rule = elasticityRuleOf(activity);
  return rule ? rule.minTotalMinutes : activity.durationMinutes;
}

export interface GreedyContext {
  readonly freezeBoundary: number;
  readonly grid: number;
  readonly lengthMinutes: number;
  readonly constants: CostConstants;
  readonly resolve: (activity: Activity) => ResolvedActivity;
  readonly weight: (activity: Activity) => number;
  readonly dayFrame: DayFrame;
  /** Every activity in today's catalogue, to look up a guest's hosts by id. */
  readonly allActivities: readonly Activity[];
  /** Host placements already settled in phase 1 (fixed + hard-set). */
  readonly initialHostPlacements: ReadonlyMap<string, Placement>;
  /** SPEC-v2.1 §15 row 2: see HardSetContext.dayBoundOf's docstring. */
  readonly dayBoundOf?: (activity: Activity) => Interval | undefined;
  /** SPEC-v2.1 §6.1: per-activity `minSeparationMinutes` from its RepeatRule. */
  readonly minSeparationOf?: (activity: Activity) => number;
  /** SPEC-v2.1 §6.1: starts of sibling occurrences already placed (greedy
   *  visits each occurrence in turn, so the prior ones are the siblings). */
  readonly siblingStartsOf?: (
    activity: Activity,
    placements: ReadonlyMap<string, Placement>,
  ) => readonly number[];
  /** SPEC-v2.1 §7.4: absolute exclusion windows resolve against the host
   * occurrence's own bucket day. Undefined reproduces v1 "always day 0". */
  readonly dayIndexOf?: (activity: Activity) => number;
}

export interface GreedyOutcome {
  readonly placements: ReadonlyMap<string, Placement>;
  readonly chunks: ReadonlyMap<string, readonly Placement[]>;
  readonly skipped: ReadonlyMap<string, SkipReason>;
}

/**
 * Phase 2 (SPEC.md Section 8.5): process the remaining candidates in
 * ascending priority rank, accepting the best placement for each against a
 * day already populated by hard-set placements and higher-priority peers.
 * No backtracking — anything already placed outranks whatever comes next.
 *
 * OverlapRule nesting (SPEC.md Section 5.7) is evaluated here too: a guest
 * competes its cheapest nested candidate, across every already-placed
 * eligible host, against its ordinary free-space result and takes whichever
 * is cheaper. "Already-placed" is exactly what makes a guest that outranks
 * its host fail to nest — its host isn't in `hostPlacements` yet when the
 * guest's own turn comes (SPEC.md Section 5.7's last bullet). Nesting into a
 * chunked host, or a nested guest itself hosting further guests, are not
 * supported — no worked example exercises either combination.
 */
export function placeGreedy(
  candidates: readonly Activity[],
  baseOccupied: readonly Interval[],
  ctx: GreedyContext,
): GreedyOutcome {
  const placements = new Map<string, Placement>();
  const chunks = new Map<string, readonly Placement[]>();
  const skipped = new Map<string, SkipReason>();
  const occupied: Interval[] = [...baseOccupied];

  const hostPlacements = new Map(ctx.initialHostPlacements);
  const hostGuests = new Map<string, Placement[]>();

  const guestToHosts = new Map<string, Activity[]>();
  for (const a of ctx.allActivities) {
    const rule = overlapRuleOf(a);
    if (!rule) continue;
    for (const guestId of rule.allowedGuestIds) {
      const hosts = guestToHosts.get(guestId) ?? [];
      hosts.push(a);
      guestToHosts.set(guestId, hosts);
    }
  }

  const ordered = [...candidates].sort((a, b) => a.priorityRank - b.priorityRank);
  for (const activity of ordered) {
    const resolved = ctx.resolve(activity);
    const dayBound = ctx.dayBoundOf?.(activity);
    const freeIntervals = computeFreeIntervals(
      occupied,
      dayBound ? Math.max(ctx.freezeBoundary, dayBound.start) : ctx.freezeBoundary,
      dayBound ? Math.min(ctx.lengthMinutes, dayBound.end) : ctx.lengthMinutes,
    );
    const context = {
      freeIntervals,
      freezeBoundary: ctx.freezeBoundary,
      grid: ctx.grid,
      lengthMinutes: ctx.lengthMinutes,
      weight: ctx.weight(activity),
      constants: ctx.constants,
      absoluteExclusions: resolveAbsoluteExclusions(
        overlapRuleOf(activity),
        ctx.dayFrame,
        ctx.dayIndexOf?.(activity) ?? 0,
      ),
      minSeparationMinutes: ctx.minSeparationOf?.(activity) ?? 0,
      siblingStarts: ctx.siblingStartsOf?.(activity, placements),
    };
    const freeResult = placeWithElasticity(
      resolved,
      elasticityRuleOf(activity),
      repeatRuleOf(activity),
      context,
    );

    let bestNested: {
      host: Activity;
      placement: Placement;
      cost: number;
      scheduledMinutes: number;
    } | null = null;
    for (const host of guestToHosts.get(activity.id) ?? []) {
      const hostPlacement = hostPlacements.get(host.id);
      if (!hostPlacement) continue; // host not placed yet — no nesting today
      const overlapRule = overlapRuleOf(host);
      if (!overlapRule) continue;
      const found = findBestNestedPlacement(
        resolved,
        elasticityFloorOf(activity),
        hostPlacement,
        overlapRule,
        hostGuests.get(host.id) ?? [],
        ctx.dayFrame,
        context,
      );
      if (found && (!bestNested || found.cost < bestNested.cost)) {
        bestNested = { host, ...found };
      }
    }

    if (bestNested && (!freeResult.placement || bestNested.cost < freeResult.cost)) {
      const hostInstanceId = `${bestNested.host.id}@${ctx.dayFrame.date}#1`;
      const placement: Placement = {
        start: bestNested.placement.start,
        end: bestNested.placement.end,
        nestedIn: hostInstanceId,
      };
      placements.set(activity.id, placement);
      const guests = hostGuests.get(bestNested.host.id) ?? [];
      guests.push(placement);
      hostGuests.set(bestNested.host.id, guests);
    } else if (freeResult.chunks) {
      chunks.set(activity.id, freeResult.chunks);
      for (const c of freeResult.chunks) occupied.push({ start: c.start, end: c.end });
    } else if (freeResult.placement) {
      placements.set(activity.id, freeResult.placement);
      occupied.push({
        start: freeResult.placement.start,
        end: freeResult.placement.end,
      });
    } else if (freeResult.skipReason) {
      skipped.set(activity.id, freeResult.skipReason);
    }

    if (overlapRuleOf(activity) && placements.has(activity.id)) {
      hostPlacements.set(activity.id, placements.get(activity.id) as Placement);
    }
  }

  return { placements, chunks, skipped };
}
