import { computeFreeIntervals } from "./intervals"
import {
  findBestNestedPlacement,
  overlapRuleOf,
  resolveAbsoluteExclusions,
} from "./overlap"
import { placeWithShrinkRule } from "./shrink"
import type { ResolvedActivity } from "./resolve"
import type {
  Activity,
  CostConstants,
  DayFrame,
  Interval,
  Placement,
  ShrinkRule,
  SkipReason,
} from "./types"

function shrinkRuleOf(activity: Activity): ShrinkRule | null {
  return (
    activity.rules.find((r): r is ShrinkRule => r.type === "shrink") ?? null
  )
}

function shrinkFloorOf(activity: Activity): number {
  const rule = shrinkRuleOf(activity)
  return rule ? rule.minDurationMinutes : activity.durationMinutes
}

export interface GreedyContext {
  readonly freezeBoundary: number
  readonly grid: number
  readonly lengthMinutes: number
  readonly constants: CostConstants
  readonly resolve: (activity: Activity) => ResolvedActivity
  readonly weight: (activity: Activity) => number
  readonly dayFrame: DayFrame
  /** Every activity in today's catalogue, to look up a guest's hosts by id. */
  readonly allActivities: readonly Activity[]
  /** Host placements already settled in phase 1 (fixed + hard-set). */
  readonly initialHostPlacements: ReadonlyMap<string, Placement>
}

export interface GreedyOutcome {
  readonly placements: ReadonlyMap<string, Placement>
  readonly chunks: ReadonlyMap<string, readonly Placement[]>
  readonly skipped: ReadonlyMap<string, SkipReason>
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
  ctx: GreedyContext
): GreedyOutcome {
  const placements = new Map<string, Placement>()
  const chunks = new Map<string, readonly Placement[]>()
  const skipped = new Map<string, SkipReason>()
  const occupied: Interval[] = [...baseOccupied]

  const hostPlacements = new Map(ctx.initialHostPlacements)
  const hostGuests = new Map<string, Placement[]>()

  const guestToHosts = new Map<string, Activity[]>()
  for (const a of ctx.allActivities) {
    const rule = overlapRuleOf(a)
    if (!rule) continue
    for (const guestId of rule.allowedGuestIds) {
      const hosts = guestToHosts.get(guestId) ?? []
      hosts.push(a)
      guestToHosts.set(guestId, hosts)
    }
  }

  const ordered = [...candidates].sort(
    (a, b) => a.priorityRank - b.priorityRank
  )
  for (const activity of ordered) {
    const resolved = ctx.resolve(activity)
    const freeIntervals = computeFreeIntervals(
      occupied,
      ctx.freezeBoundary,
      ctx.lengthMinutes
    )
    const context = {
      freeIntervals,
      freezeBoundary: ctx.freezeBoundary,
      grid: ctx.grid,
      lengthMinutes: ctx.lengthMinutes,
      weight: ctx.weight(activity),
      constants: ctx.constants,
      absoluteExclusions: resolveAbsoluteExclusions(
        overlapRuleOf(activity),
        ctx.dayFrame
      ),
    }
    const freeResult = placeWithShrinkRule(
      resolved,
      shrinkRuleOf(activity),
      context
    )

    let bestNested: {
      host: Activity
      placement: Placement
      cost: number
      scheduledMinutes: number
    } | null = null
    for (const host of guestToHosts.get(activity.id) ?? []) {
      const hostPlacement = hostPlacements.get(host.id)
      if (!hostPlacement) continue // host not placed yet — no nesting today
      const overlapRule = overlapRuleOf(host)
      if (!overlapRule) continue
      const found = findBestNestedPlacement(
        resolved,
        shrinkFloorOf(activity),
        hostPlacement,
        overlapRule,
        hostGuests.get(host.id) ?? [],
        ctx.dayFrame,
        context
      )
      if (found && (!bestNested || found.cost < bestNested.cost)) {
        bestNested = { host, ...found }
      }
    }

    if (
      bestNested &&
      (!freeResult.placement || bestNested.cost < freeResult.cost)
    ) {
      const placement: Placement = {
        start: bestNested.placement.start,
        end: bestNested.placement.end,
        nestedIn: bestNested.host.id,
      }
      placements.set(activity.id, placement)
      const guests = hostGuests.get(bestNested.host.id) ?? []
      guests.push(placement)
      hostGuests.set(bestNested.host.id, guests)
    } else if (freeResult.chunks) {
      chunks.set(activity.id, freeResult.chunks)
      for (const c of freeResult.chunks)
        occupied.push({ start: c.start, end: c.end })
    } else if (freeResult.placement) {
      placements.set(activity.id, freeResult.placement)
      occupied.push({
        start: freeResult.placement.start,
        end: freeResult.placement.end,
      })
    } else if (freeResult.skipReason) {
      skipped.set(activity.id, freeResult.skipReason)
    }

    if (overlapRuleOf(activity) && placements.has(activity.id)) {
      hostPlacements.set(activity.id, placements.get(activity.id) as Placement)
    }
  }

  return { placements, chunks, skipped }
}
