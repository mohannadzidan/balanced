import { computeFreeIntervals } from "./intervals"
import { evaluateCandidate } from "./resolve"
import type { ResolvedActivity } from "./resolve"
import type {
  Activity,
  Interval,
  Placement,
  Relaxation,
  SequenceRule,
  SkipReason,
} from "./types"

export function sequenceRuleOf(activity: Activity): SequenceRule | undefined {
  return activity.rules.find((r): r is SequenceRule => r.type === "sequence")
}

export function isDependent(activity: Activity): boolean {
  return sequenceRuleOf(activity) !== undefined
}

export interface DependentPlacementResult {
  readonly placement: Placement
  readonly gapMinutes: number
}

/**
 * Cheapest legal placement of one dependent immediately adjacent to its host
 * (SPEC.md Section 5.6): gap minimised first — 0, then GRID, up to
 * max_gap_minutes — each candidate still subject to the dependent's own
 * window rules and free-space availability.
 */
export function findDependentPlacement(
  resolvedDependent: ResolvedActivity,
  rule: SequenceRule,
  host: { readonly start: number; readonly end: number },
  freeIntervals: readonly Interval[],
  freezeBoundary: number,
  lengthMinutes: number,
  grid: number
): DependentPlacementResult | null {
  const duration = resolvedDependent.activity.durationMinutes

  for (let g = 0; g <= rule.maxGapMinutes; g += grid) {
    const start = rule.role === "pre" ? host.start - duration - g : host.end + g
    if (start < freezeBoundary) continue
    const end = start + duration
    if (end > lengthMinutes) continue
    const fits = freeIntervals.some((iv) => iv.start <= start && end <= iv.end)
    if (!fits) continue
    if (!evaluateCandidate(resolvedDependent, start, end).feasible) continue
    return { placement: { start, end, nestedIn: null }, gapMinutes: g }
  }
  return null
}

export interface SequenceChainContext {
  readonly freezeBoundary: number
  readonly lengthMinutes: number
  readonly grid: number
  readonly resolve: (activity: Activity) => ResolvedActivity
}

export interface SequenceChainOutcome {
  readonly placements: ReadonlyMap<string, Placement>
  readonly skipped: ReadonlyMap<string, SkipReason>
  readonly relaxations: ReadonlyMap<string, readonly Relaxation[]>
}

/**
 * Places every sequence dependent immediately adjacent to its (already
 * resolved) host, out of priority order (SPEC.md Section 5.6, Section 8.6
 * step 6). Processed in rounds so chains (`A pre B`, `B pre C`) resolve once
 * their own host becomes available. A host that is skipped propagates a
 * free, zero-cost `HOST_SKIPPED` skip to its dependent.
 *
 * Simplification: unlike Section 8.6 step 3, a host's own placement search
 * (hard-set.ts / greedy.ts) does not treat "no legal spot for its
 * dependent" as making that host candidate infeasible — hosts are placed
 * first, independent of their dependents, and a dependent that finds no
 * adjacent room is skipped instead (reason `NO_FREE_SPACE`) rather than
 * forcing the host to relocate. This only diverges from the spec when a
 * host's cheapest slot happens to leave no room for its dependent while a
 * costlier slot would have.
 */
export function placeSequenceChain(
  dependents: readonly Activity[],
  hostResolutions: ReadonlyMap<string, Placement | "SKIPPED">,
  baseOccupied: readonly Interval[],
  ctx: SequenceChainContext
): SequenceChainOutcome {
  const placements = new Map<string, Placement>()
  const skipped = new Map<string, SkipReason>()
  const relaxations = new Map<string, readonly Relaxation[]>()
  const resolved = new Map<string, Placement | "SKIPPED">(hostResolutions)
  const occupied: Interval[] = [...baseOccupied]

  let remaining = [...dependents]
  let progressed = true
  while (remaining.length > 0 && progressed) {
    progressed = false
    const stillRemaining: Activity[] = []

    for (const dependent of remaining) {
      const rule = sequenceRuleOf(dependent)
      if (!rule) continue // unreachable: `dependents` is pre-filtered
      const hostResolution = resolved.get(rule.linkedActivityId)

      if (hostResolution === undefined) {
        stillRemaining.push(dependent)
        continue
      }
      progressed = true

      if (hostResolution === "SKIPPED") {
        skipped.set(dependent.id, "HOST_SKIPPED")
        resolved.set(dependent.id, "SKIPPED")
        continue
      }

      const freeIntervals = computeFreeIntervals(
        occupied,
        ctx.freezeBoundary,
        ctx.lengthMinutes
      )
      const found = findDependentPlacement(
        ctx.resolve(dependent),
        rule,
        hostResolution,
        freeIntervals,
        ctx.freezeBoundary,
        ctx.lengthMinutes,
        ctx.grid
      )

      if (found) {
        placements.set(dependent.id, found.placement)
        occupied.push({
          start: found.placement.start,
          end: found.placement.end,
        })
        resolved.set(dependent.id, found.placement)
        if (found.gapMinutes > 0) {
          relaxations.set(dependent.id, [
            { type: "gap", minutes: found.gapMinutes },
          ])
        }
      } else {
        skipped.set(dependent.id, "NO_FREE_SPACE")
        resolved.set(dependent.id, "SKIPPED")
      }
    }
    remaining = stillRemaining
  }

  // Anything left has no resolvable host — a validation-time SEQUENCE_CYCLE
  // should already prevent this; skip defensively rather than loop forever.
  for (const dependent of remaining) {
    skipped.set(dependent.id, "NO_FREE_SPACE")
  }

  return { placements, skipped, relaxations }
}
