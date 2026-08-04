/**
 * Pure rolling-target math for the Tracking Rule's carry-over ledger
 * (PRD §3.3). Never touches the database — `lib/db/tracking-queries.ts`
 * gathers the inputs and persists the result.
 */

export type CarryOverEvaluation = {
  /** Minutes actually logged on the evaluated day. */
  achievedMin: number
  /** The target that was in effect for the evaluated day. */
  expectedMin: number
  /** True if the evaluated day was a vacation day for this activity. */
  wasVacation: boolean
}

export type RollingTargetInput = {
  baseTargetMin: number
  capMin: number | null
  /** `null` when there is no prior day to evaluate yet (first-ever run). */
  evaluation: CarryOverEvaluation | null
}

function clampToCap(target: number, capMin: number | null): number {
  const nonNegative = Math.max(0, target)
  return capMin === null ? nonNegative : Math.min(nonNegative, capMin)
}

/**
 * The next rolling target: a deficit (expected > achieved) raises tomorrow's
 * target, a surplus lowers it, and a vacation day resets to the base target
 * without carrying anything forward (PRD: "prorate targets to zero without
 * creating deficits").
 */
export function nextRollingTarget(input: RollingTargetInput): number {
  if (input.evaluation === null || input.evaluation.wasVacation) {
    return clampToCap(input.baseTargetMin, input.capMin)
  }

  const deficitMin = input.evaluation.expectedMin - input.evaluation.achievedMin
  return clampToCap(input.baseTargetMin + deficitMin, input.capMin)
}

/** Carry-over disabled: the target is always just the base target, no rolling. */
export function nextRollingTargetNoCarryOver(
  baseTargetMin: number,
  capMin: number | null
): number {
  return clampToCap(baseTargetMin, capMin)
}
