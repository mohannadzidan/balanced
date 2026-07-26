import { computeFreeIntervals, intervalLength } from "./intervals"
import type {
  Activity,
  CostBreakdown,
  CostConstants,
  TimelineActivity,
} from "./types"

/** W(a) = R + 1 − r, where r is the activity's rank in a catalogue of R ranked activities. */
export function priorityWeight(rank: number, totalRanked: number): number {
  return totalRanked + 1 - rank
}

export interface CandidateEvaluation {
  readonly scheduledMinutes: number
  readonly chunkCount: number
  readonly driftMinutes: number
  readonly gapMinutes: number
}

/**
 * Cost of one candidate placement (SPEC.md Section 7.3), excluding idle.
 * Used to choose among candidates during single-activity placement search.
 */
export function placementCost(
  durationMinutes: number,
  weight: number,
  evaluation: CandidateEvaluation,
  constants: CostConstants
): number {
  const unscheduled = Math.max(0, durationMinutes - evaluation.scheduledMinutes)
  return (
    weight * constants.SHRINK * unscheduled +
    weight * constants.CHUNK * Math.max(0, evaluation.chunkCount - 1) +
    weight * constants.DRIFT * evaluation.driftMinutes +
    weight * constants.GAP * evaluation.gapMinutes
  )
}

export function skipCost(
  weight: number,
  constants: CostConstants,
  opts: { readonly isMandatory: boolean; readonly isDependentSkip: boolean }
): number {
  if (opts.isDependentSkip) return 0
  if (opts.isMandatory) return Number.POSITIVE_INFINITY
  return weight * constants.SKIP
}

function sumRelaxation(
  relaxations: TimelineActivity["relaxations"],
  type: "drift" | "gap"
): number {
  return relaxations
    .filter((r) => r.type === type)
    .reduce((sum, r) => sum + r.minutes, 0)
}

function computeIdleMinutes(
  instances: readonly TimelineActivity[],
  lengthMinutes: number
): number {
  const occupied = instances
    .filter(
      (i) =>
        i.hostInstanceId === null &&
        i.plannedStart !== null &&
        i.plannedEnd !== null
    )
    .map((i) => ({
      start: i.plannedStart as number,
      end: i.plannedEnd as number,
    }))
  const free = computeFreeIntervals(occupied, 0, lengthMinutes)
  return free.reduce((sum, iv) => sum + intervalLength(iv), 0)
}

/**
 * Whole-timeline cost (SPEC.md Section 7.5): sum of placement costs, skip
 * costs, and idle. Derived entirely from the instances' own recorded
 * relaxations — no need for the originating Activity catalogue.
 */
export function scheduleCost(
  instances: readonly TimelineActivity[],
  lengthMinutes: number,
  totalRanked: number,
  constants: CostConstants
): CostBreakdown {
  let skip = 0
  let shrink = 0
  let chunk = 0
  let drift = 0
  let gap = 0
  const perInstance: Record<string, number> = {}

  for (const inst of instances) {
    const weight = priorityWeight(inst.priorityRank, totalRanked)
    let instCost: number

    if (inst.state === "SKIPPED") {
      const isMandatory = inst.rules.some((r) => r.type === "mandatory")
      const isDependentSkip = inst.skipReason === "HOST_SKIPPED"
      instCost = skipCost(weight, constants, { isMandatory, isDependentSkip })
      skip += instCost
    } else {
      const unscheduled = Math.max(
        0,
        inst.durationMinutes - inst.scheduledMinutes
      )
      const driftMinutes = sumRelaxation(inst.relaxations, "drift")
      const gapMinutes = sumRelaxation(inst.relaxations, "gap")

      const s = weight * constants.SHRINK * unscheduled
      const c = weight * constants.CHUNK * Math.max(0, inst.chunkCount - 1)
      const d = weight * constants.DRIFT * driftMinutes
      const g = weight * constants.GAP * gapMinutes

      shrink += s
      chunk += c
      drift += d
      gap += g
      instCost = s + c + d + g
    }

    perInstance[inst.id] = instCost
  }

  const idle = constants.IDLE * computeIdleMinutes(instances, lengthMinutes)
  const total = skip + shrink + chunk + drift + gap + idle

  return { total, skip, shrink, chunk, drift, gap, idle, perInstance }
}

/**
 * Section 7.4's dominance invariant, cancelled of W(a): true when skipping
 * `activity` would NOT always cost strictly more than its worst legal
 * relaxation. `validateActivity` reports this as DOMINANCE_VIOLATION.
 */
export function violatesDominance(
  activity: Activity,
  constants: CostConstants
): boolean {
  const shrinkRule = activity.rules.find((r) => r.type === "shrink")
  const flexibleRule = activity.rules.find((r) => r.type === "flexibleWindow")
  const sequenceRule = activity.rules.find((r) => r.type === "sequence")

  const shrinkTerm =
    shrinkRule && shrinkRule.type === "shrink"
      ? constants.SHRINK *
        (activity.durationMinutes - shrinkRule.minDurationMinutes)
      : 0
  const chunkTerm =
    shrinkRule && shrinkRule.type === "shrink" && shrinkRule.chunkingAllowed
      ? constants.CHUNK * (shrinkRule.maxChunks - 1)
      : 0
  const driftTerm =
    flexibleRule && flexibleRule.type === "flexibleWindow"
      ? constants.DRIFT * flexibleRule.maxDriftMinutes
      : 0
  const gapTerm =
    sequenceRule && sequenceRule.type === "sequence"
      ? constants.GAP * sequenceRule.maxGapMinutes
      : 0

  return constants.SKIP <= shrinkTerm + chunkTerm + driftTerm + gapTerm
}
