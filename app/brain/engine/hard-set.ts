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
 * Over a multi-day frame (Drop 2), the next day's length is read from
 * `frame.days[dayIndex + 1]` directly. At the frame's last day there is no
 * next day in the table; the length is computed from the calendar in the
 * frame's timezone without round-tripping through a whole new Frame.
 */
export function resolveFixedPlacement(
  rule: FixedRule,
  frame: DayFrame
): Placement {
  const start = resolveWallClock(rule.startWall, frame)
  const rawEnd = resolveWallClock(rule.endWall, frame)
  if (rawEnd > start) return { start, end: rawEnd, nestedIn: null }

  // Spanning window: end belongs to the day after this FixedRule's own day.
  // FixedRule has no day-index concept yet (Drop 1 only ever calls this with
  // a single-day frame), so "this FixedRule's day" is always day 0.
  const thisDay = frame.days[0]
  const dayStart = thisDay.startOffset
  const nextLength =
    frame.days[1]?.lengthMinutes ??
    lengthMinutesOfDate(addDays(frame.startDate, 1), frame.timezone)
  const endWallOffset = resolveWallClock(rule.endWall, frame, 0) - dayStart
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
  baseOccupied: readonly Interval[] = []
): FixedSetOutcome {
  const withFixed = activities
    .map((activity) => {
      const rule = fixedRuleOf(activity)
      return rule
        ? { activity, placement: resolveFixedPlacement(rule, dayFrame) }
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
}

export interface HardSetOutcome {
  readonly placements: ReadonlyMap<string, Placement>
  readonly skipped: ReadonlyMap<string, SkipReason>
  readonly nodesUsed: number
}

function candidatesFor(
  activity: Activity,
  occupied: readonly Interval[],
  ctx: HardSetContext
): Placement[] {
  const freeIntervals = computeFreeIntervals(
    occupied,
    ctx.freezeBoundary,
    ctx.lengthMinutes
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
        ctx.dayFrame
      ),
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
      frame = { candidates: candidatesFor(activity, occupied, ctx), attempt: 0 }
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
