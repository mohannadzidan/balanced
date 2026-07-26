import type { CostConstants } from "./types"

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
