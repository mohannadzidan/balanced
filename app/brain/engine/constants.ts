import type { CostConstants } from "./types"
import type { ResolvedWindow } from "./resolve"

export const GRID = 5

export const DEFAULT_COST_CONSTANTS: CostConstants = {
  SKIP: 10_000,
  SHRINK: 20,
  CHUNK: 200,
  DRIFT: 10,
  GAP: 5,
  IDLE: 1,
  GRID,
  HARD_SET_NODE_LIMIT: 5000,
}

export function resolveConstants(
  overrides: Partial<CostConstants> | undefined
): CostConstants {
  return { ...DEFAULT_COST_CONSTANTS, ...overrides }
}

/** SPEC-v2.1 §4.1: tailroom = max(0, max over windows of (w.end − lengthMinutes)) */
export function computeTailroom(
  windows: readonly ResolvedWindow[],
  lengthMinutes: number,
): number {
  let maxExcess = 0
  for (const w of windows) {
    const excess = w.end - lengthMinutes
    if (excess > maxExcess) maxExcess = excess
  }
  return maxExcess
}
