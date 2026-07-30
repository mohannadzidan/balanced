import { computeFreeIntervals, intervalsOverlap } from "./intervals"
import { overlapRuleOf, resolveAbsoluteExclusions } from "./overlap"
import { enumerateFeasiblePlacementsAcrossLengths } from "./placement"
import type { ResolvedActivity } from "./resolve"
import { addDays, lengthMinutesOfDate, resolveWallClock } from "./time"
import type {
  Activity,
  CostConstants,
  DayFrame,
  Diagnostic,
  ElasticityRule,
  FixedRule,
  Interval,
  Placement,
  SkipReason,
} from "./types"

function fixedRuleOf(activity: Activity): FixedRule | undefined {
  return activity.rules.find((r): r is FixedRule => r.type === "fixed")
}

function elasticityFloorOf(activity: Activity): number {
  const rule = activity.rules.find(
    (r): r is ElasticityRule => r.type === "elasticity"
  )
  return rule ? rule.minTotalMinutes : activity.durationMinutes
}

/**
 * Resolves a FixedRule's wall-clock endpoints to offsets in `frame`
 * (SPEC-v2.1 §4). `end_wall <= start_wall` means the block spans midnight
 * (Section 5.1): its end belongs to the following calendar date, whose DST
 * length may differ from today's — on a transition night, "06:00" the next
 * morning can be 300 or 420 real minutes past local midnight, not 360.
 *
 * `dayIndex` (SPEC-v2.1 §7.1: "each resolving 09:00 against its own day") is
 * which `frame.days` entry this occurrence's FixedRule resolves against —
 * 0 for Drop 1's single-day frame, or a bucketed occurrence's own day over a
 * multi-day frame. Over a multi-day frame, the next day's length is read
 * from `frame.days[dayIndex + 1]` directly; at the frame's last day there is
 * no next day in the table, so it's computed from the calendar in the
 * frame's timezone without round-tripping through a whole new Frame.
 */
export function resolveFixedPlacement(
  rule: FixedRule,
  frame: DayFrame,
  dayIndex = 0
): Placement {
  const start = resolveWallClock(rule.startWall, frame, dayIndex)
  const rawEnd = resolveWallClock(rule.endWall, frame, dayIndex)
  if (rawEnd > start) return { start, end: rawEnd, nestedIn: null }

  // Spanning window: end belongs to the day after this FixedRule's own day.
  const thisDay = frame.days[dayIndex]
  const dayStart = thisDay.startOffset
  const nextLength =
    frame.days[dayIndex + 1]?.lengthMinutes ??
    lengthMinutesOfDate(addDays(thisDay.date, 1), frame.timezone)
  const endWallOffset = resolveWallClock(rule.endWall, frame, dayIndex) - dayStart
  return {
    start,
    end: dayStart + nextLength + endWallOffset,
    nestedIn: null,
  }
}

export interface FixedSetOutcome {
  readonly placements: ReadonlyMap<string, Placement>
  readonly skipped: ReadonlyMap<string, SkipReason>
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Phase 1, sub-step 1 (SPEC.md Section 8.4): place every FixedRule activity
 * at its declared time. Two fixed blocks that overlap are a hard
 * configuration error — both are marked infeasible with a blocking
 * diagnostic rather than one arbitrarily winning. A fixed block colliding
 * with time already spoken for by an anchor (most notably a carry-in block
 * from yesterday — Section 3.4: "nothing may be scheduled before a carry-in
 * block ends") is the same kind of hard error, since a declared exact time
 * is never subject to the ordinary free-interval search that anchors
 * normally clear out of.
 */
export function placeFixedSet(
  activities: readonly Activity[],
  dayFrame: DayFrame,
  freezeBoundary: number,
  baseOccupied: readonly Interval[] = [],
  dayIndexOf: (activity: Activity) => number = () => 0
): FixedSetOutcome {
  const withFixed = activities
    .map((activity) => {
      const rule = fixedRuleOf(activity)
      return rule
        ? {
            activity,
            placement: resolveFixedPlacement(rule, dayFrame, dayIndexOf(activity)),
          }
        : null
    })
    .filter(
      (x): x is { activity: Activity; placement: Placement } => x !== null
    )

  const conflicted = new Set<string>()
  for (let i = 0; i < withFixed.length; i++) {
    if (withFixed[i].placement.start < freezeBoundary) {
      conflicted.add(withFixed[i].activity.id)
    }
    if (
      baseOccupied.some((occ) => intervalsOverlap(withFixed[i].placement, occ))
    ) {
      conflicted.add(withFixed[i].activity.id)
    }
    for (let j = i + 1; j < withFixed.length; j++) {
      const a = withFixed[i].placement
      const b = withFixed[j].placement
      if (intervalsOverlap(a, b)) {
        conflicted.add(withFixed[i].activity.id)
        conflicted.add(withFixed[j].activity.id)
      }
    }
  }

  const placements = new Map<string, Placement>()
  const skipped = new Map<string, SkipReason>()
  const diagnostics: Diagnostic[] = []

  if (conflicted.size > 0) {
    const names = withFixed
      .filter((x) => conflicted.has(x.activity.id))
      .map((x) => x.activity.name)
    diagnostics.push({
      severity: "blocking",
      code: "FIXED_COLLISION",
      instanceIds: [...conflicted],
      message: `Fixed activities overlap: ${names.join(", ")}`,
      suggestedFix:
        "Change one activity's fixed time, or remove the FixedRule from one of them.",
    })
  }

  for (const { activity, placement } of withFixed) {
    if (conflicted.has(activity.id)) {
      skipped.set(activity.id, "INFEASIBLE_HARD_CONSTRAINT")
    } else {
      placements.set(activity.id, placement)
    }
  }

  return { placements, skipped, diagnostics }
}

export interface HardSetContext {
  readonly freezeBoundary: number
  readonly grid: number
  readonly lengthMinutes: number
  readonly nodeLimit: number
  readonly constants: CostConstants
  readonly resolve: (activity: Activity) => ResolvedActivity
  readonly weight: (activity: Activity) => number
  readonly dayFrame: DayFrame
  /** SPEC-v2.1 §15 row 2: confines a ghosted activity's free-interval search
   * to its own day, so a generous drift allowance can't let it drift into
   * another day's free time — window/drift feasibility alone only measures
   * how much of the candidate's own duration spills past the window edge,
   * not true distance, so it can't catch a candidate an entire day away.
   * Undefined for every existing caller (dayCount=1, or any activity that
   * isn't a §15 row 2 ghost), which reproduces today's behavior exactly. */
  readonly dayBoundOf?: (activity: Activity) => Interval | undefined
  /** SPEC-v2.1 §6.1: per-item `minSeparationMinutes` (start-to-start against
   * any already-placed sibling). Undefined for the legacy single-occurrence
   * path, which reproduces today's behavior exactly. */
  readonly minSeparationOf?: (activity: Activity) => number
  /** SPEC-v2.1 §6.1: per-item list of already-placed sibling starts. The
   * `placements` map is keyed by `solveActivities[i].id` (= `placementKeyOf`
   * for an occurrence, which equals its own occurrence id when the activity
   * has multiple occurrences this solve). Paired with `minSeparationOf` to
   * thread the start-to-start filter through the existing enumeration. */
  readonly siblingStartsOf?: (
    activity: Activity,
    placements: ReadonlyMap<string, Placement>
  ) => readonly number[]
  /** SPEC-v2.1 §7.4: absolute exclusion windows resolve against the host
   * occurrence's own bucket day, not always day 0. Undefined reproduces v1
   * "always day 0" behavior exactly. */
  readonly dayIndexOf?: (activity: Activity) => number
}

export interface HardSetOutcome {
  readonly placements: ReadonlyMap<string, Placement>
  readonly skipped: ReadonlyMap<string, SkipReason>
  readonly nodesUsed: number
}

function candidatesFor(
  activity: Activity,
  occupied: readonly Interval[],
  ctx: HardSetContext,
  placements: ReadonlyMap<string, Placement> = new Map()
): Placement[] {
  const dayBound = ctx.dayBoundOf?.(activity)
  const freeIntervals = computeFreeIntervals(
    occupied,
    dayBound ? Math.max(ctx.freezeBoundary, dayBound.start) : ctx.freezeBoundary,
    dayBound ? Math.min(ctx.lengthMinutes, dayBound.end) : ctx.lengthMinutes
  )
  return enumerateFeasiblePlacementsAcrossLengths(
    ctx.resolve(activity),
    elasticityFloorOf(activity),
    {
      freeIntervals,
      freezeBoundary: ctx.freezeBoundary,
      grid: ctx.grid,
      lengthMinutes: ctx.lengthMinutes,
      weight: ctx.weight(activity),
      constants: ctx.constants,
      absoluteExclusions: resolveAbsoluteExclusions(
        overlapRuleOf(activity),
        ctx.dayFrame,
        ctx.dayIndexOf?.(activity) ?? 0
      ),
      minSeparationMinutes: ctx.minSeparationOf?.(activity) ?? 0,
      siblingStarts: ctx.siblingStartsOf?.(activity, placements),
    }
  )
}

/**
 * Phase 1, sub-steps 2–5 (SPEC.md Section 8.4): the non-fixed hard set
 * (currently MandatoryRule activities without a FixedRule), most-constrained
 * first, with bounded chronological backtracking on failure.
 */
export function placeHardSet(
  items: readonly Activity[],
  baseOccupied: readonly Interval[],
  ctx: HardSetContext
): HardSetOutcome {
  const ordered = [...items].sort((a, b) => {
    const countA = candidatesFor(a, baseOccupied, ctx).length
    const countB = candidatesFor(b, baseOccupied, ctx).length
    return countA !== countB ? countA - countB : a.priorityRank - b.priorityRank
  })

  const placements = new Map<string, Placement>()
  const skipped = new Map<string, SkipReason>()
  const frames = new Map<number, { candidates: Placement[]; attempt: number }>()
  const path: number[] = []
  let nodes = 0
  let cursor = 0

  while (cursor < ordered.length) {
    const activity = ordered[cursor]
    if (skipped.has(activity.id)) {
      cursor++
      continue
    }

    nodes++
    if (nodes > ctx.nodeLimit) {
      for (let k = cursor; k < ordered.length; k++) {
        if (!skipped.has(ordered[k].id) && !placements.has(ordered[k].id)) {
          skipped.set(ordered[k].id, "INFEASIBLE_HARD_CONSTRAINT")
        }
      }
      break
    }

    let frame = frames.get(cursor)
    if (!frame) {
      const occupied: Interval[] = [
        ...baseOccupied,
        ...path.map((idx) => placements.get(ordered[idx].id) as Placement),
      ]
      frame = {
        candidates: candidatesFor(activity, occupied, ctx, placements),
        attempt: 0,
      }
      frames.set(cursor, frame)
    }

    if (frame.attempt < frame.candidates.length) {
      placements.set(activity.id, frame.candidates[frame.attempt])
      path.push(cursor)
      cursor++
      continue
    }

    // Exhausted every candidate for this activity: backtrack.
    frames.delete(cursor)
    if (path.length === 0) {
      // No earlier commitment to blame — this one is infeasible on its own.
      skipped.set(activity.id, "INFEASIBLE_HARD_CONSTRAINT")
      cursor++
      continue
    }
    const prevIdx = path.pop() as number
    placements.delete(ordered[prevIdx].id)
    const prevFrame = frames.get(prevIdx)
    if (prevFrame) prevFrame.attempt++
    cursor = prevIdx
  }

  return { placements, skipped, nodesUsed: nodes }
}

/**
 * SPEC-v2.1 §6.2: place a group of sibling occurrences (one activity's
 * expansion this solve) as one bounded-backtracking node. A "thin wrapper
 * over placeHardSet" by design — the spec explicitly forbids writing a
 * second search: the existing routine already sorts most-constrained-first,
 * already backtracks on failure, and already shares a single node-limit
 * budget. The only thing it doesn't do natively is per-occurrence
 * `minSeparationMinutes`; that's wired via two optional callbacks on
 * `HardSetContext` (`minSeparationOf` / `siblingStartsOf`) that are no-ops
 * for every non-occurrence-group caller.
 *
 * `minSeparationOf` reads `minSeparationMinutes` off any `RepeatRule` on
 * the item. `siblingStartsOf` returns the starts of every *other* group
 * member already committed in this search (every key in `placements`
 * belonging to one of `items` whose start isn't this item's own current
 * candidate — same-group and same-item are filtered out).
 *
 * Caller is expected to feed the group in their natural occurrence order;
 * `placeHardSet` reorders internally to most-constrained-first, so the
 * caller's ordering is informational only.
 */
export function placeOccurrenceGroup(
  items: readonly Activity[],
  baseOccupied: readonly Interval[],
  ctx: HardSetContext
): HardSetOutcome {
  const itemIds = new Set(items.map((i) => i.id))
  const siblingStartsOf = (
    activity: Activity,
    placements: ReadonlyMap<string, Placement>
  ): readonly number[] => {
    const starts: number[] = []
    for (const [id, p] of placements) {
      if (!itemIds.has(id) || id === activity.id) continue
      starts.push(p.start)
    }
    return starts
  }
  const minSeparationOf = (activity: Activity): number => {
    const rule = activity.rules.find(
      (r): r is import("./types").RepeatRule => r.type === "repeat"
    )
    return rule?.minSeparationMinutes ?? 0
  }
  return placeHardSet(items, baseOccupied, {
    ...ctx,
    minSeparationOf,
    siblingStartsOf,
  })
}

/**
 * SPEC-v2.1 §15 row 5 / §6.3 footgun mitigation: required occurrences whose
 * candidate spans don't overlap cannot conflict — group them by candidate-
 * span overlap (union-find) and run `placeOccurrenceGroup` per component,
 * so each search stays well inside `nodeLimit`. The global limit stays as
 * a backstop across components (sum of `nodesUsed`).
 *
 * "About twenty lines" per the spec. Implementation: precompute every
 * item's candidate span (`[min(start), max(end)]` across its feasible
 * candidates — already cached inside `candidatesFor`); union-find by
 * pairwise span overlap; run `placeOccurrenceGroup` per component. Items
 * with no feasible candidates fall straight into the skip map with
 * `INFEASIBLE_HARD_CONSTRAINT` — no point sending them through a search.
 */
export function placeHardSetDecomposed(
  items: readonly Activity[],
  baseOccupied: readonly Interval[],
  ctx: HardSetContext
): HardSetOutcome {
  const placements = new Map<string, Placement>()
  const skipped = new Map<string, SkipReason>()
  let nodesUsed = 0

  // Precompute each item's candidate span. An item with zero feasible
  // candidates is dead on arrival — record the skip here and exclude from
  // decomposition so the search doesn't waste a node on it.
  const span = new Map<string, { start: number; end: number }>()
  const alive: Activity[] = []
  for (const item of items) {
    const candidates = candidatesFor(item, baseOccupied, ctx, placements)
    if (candidates.length === 0) {
      skipped.set(item.id, "INFEASIBLE_HARD_CONSTRAINT")
      continue
    }
    let s = Number.POSITIVE_INFINITY
    let e = Number.NEGATIVE_INFINITY
    for (const c of candidates) {
      if (c.start < s) s = c.start
      if (c.end > e) e = c.end
    }
    span.set(item.id, { start: s, end: e })
    alive.push(item)
  }
  if (alive.length === 0) {
    return { placements, skipped, nodesUsed }
  }

  // Union-find by pairwise span overlap.
  const parent = new Map<string, string>()
  for (const item of alive) parent.set(item.id, item.id)
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) {
      const p = parent.get(r) as string
      parent.set(r, parent.get(p) as string) // path compression
      r = parent.get(r) as string
    }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const sa = span.get(alive[i].id)!
      const sb = span.get(alive[j].id)!
      if (sa.start < sb.end && sb.start < sa.end) {
        union(alive[i].id, alive[j].id)
      }
    }
  }
  const components = new Map<string, Activity[]>()
  for (const item of alive) {
    const root = find(item.id)
    const arr = components.get(root) ?? []
    arr.push(item)
    components.set(root, arr)
  }

  // Run each component through the existing bounded search.
  for (const component of components.values()) {
    const componentOccupied: Interval[] = [
      ...baseOccupied,
      ...[...placements.values()].map((p) => ({ start: p.start, end: p.end })),
    ]
    const outcome = placeOccurrenceGroup(component, componentOccupied, ctx)
    for (const [id, p] of outcome.placements) placements.set(id, p)
    for (const [id, s] of outcome.skipped) skipped.set(id, s)
    nodesUsed += outcome.nodesUsed
  }

  return { placements, skipped, nodesUsed }
}
