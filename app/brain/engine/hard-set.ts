import { computeFreeIntervals, intervalsOverlap } from "./intervals"
import { overlapRuleOf, resolveAbsoluteExclusions } from "./overlap"
import { enumerateFeasiblePlacementsAcrossLengths } from "./placement"
import type { ResolvedActivity } from "./resolve"
import { addDays, resolveDayFrame, resolveWallClock } from "./time"
import type {
  Activity,
  CostConstants,
  DayFrame,
  Diagnostic,
  FixedRule,
  Interval,
  Placement,
  ShrinkRule,
  SkipReason,
} from "./types"

function fixedRuleOf(activity: Activity): FixedRule | undefined {
  return activity.rules.find((r): r is FixedRule => r.type === "fixed")
}

function shrinkFloorOf(activity: Activity): number {
  const rule = activity.rules.find((r): r is ShrinkRule => r.type === "shrink")
  return rule ? rule.minDurationMinutes : activity.durationMinutes
}

/**
 * Resolves a FixedRule's wall-clock endpoints to offsets in `dayFrame`.
 * `end_wall <= start_wall` means the block spans midnight (Section 5.1): its
 * end belongs to the following calendar date, which may have a different
 * DST length than today — resolving it against today's `dayFrame` plus
 * today's own `lengthMinutes` would silently absorb or fabricate an hour on
 * a transition night, so it's resolved against tomorrow's own DayFrame
 * instead (Section 3.3/3.4).
 */
export function resolveFixedPlacement(
  rule: FixedRule,
  dayFrame: DayFrame
): Placement {
  const start = resolveWallClock(rule.startWall, dayFrame)
  const rawEnd = resolveWallClock(rule.endWall, dayFrame)
  if (rawEnd > start) return { start, end: rawEnd, nestedIn: null }

  const tomorrow = resolveDayFrame(addDays(dayFrame.date, 1), dayFrame.timezone)
  const overflow = resolveWallClock(rule.endWall, tomorrow)
  return { start, end: dayFrame.lengthMinutes + overflow, nestedIn: null }
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
    shrinkFloorOf(activity),
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
