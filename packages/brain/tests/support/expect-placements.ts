import { expect } from "vitest";

import type { SolveResult } from "../../src/engine/types";

function fmt(minutesFromMidnight: number): string {
  const total = ((minutesFromMidnight % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Top-level (non-guest) instance placements, keyed by activity name. */
export function actualPlacements(result: SolveResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const inst of result.timeline.instances) {
    if (inst.hostInstanceId !== null) continue;
    out[inst.name] =
      inst.state === "SKIPPED"
        ? "SKIPPED"
        : `${fmt(inst.plannedStart ?? 0)}-${fmt(inst.plannedEnd ?? 0)}`;
  }
  return out;
}

/**
 * Asserts top-level placements against a map of activity name -> "HH:MM-HH:MM"
 * or "SKIPPED", per SPEC.md Section 16.1. Catches unintended collateral
 * movement that a chain of individual `expect` calls would miss.
 */
export function expectPlacements(result: SolveResult, expected: Record<string, string>): void {
  expect(actualPlacements(result)).toEqual(expected);
}
