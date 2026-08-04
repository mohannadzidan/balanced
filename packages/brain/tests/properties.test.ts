// Property-based tests for SPEC.md §16.1 layer 5 invariants.
// SPEC-v2.1.md §15.1 criterion 3: all these must hold over N-day frames as well.
//
// Started with determinism as an infrastructure smoke test. Other layer-5
// properties (no overlap, shrink floor, mandatory, cost monotonicity, tick
// idempotence, rejection purity) land alongside the equivalence property in
// subsequent slices.

import { describe, it } from "vitest";
import * as fc from "fast-check";

import { solve } from "../src/engine/solve";
import { resolveDayFrame } from "../src/engine/time";
import { catalogArb, dateArb } from "./support/arbitraries";
import { checkInvariants } from "../src/engine/invariants";

describe("brain engine — property-based tests (SPEC.md §16.1 layer 5)", () => {
  it("determinism: solve(x) twice produces structurally identical results", () => {
    fc.assert(
      fc.property(dateArb, catalogArb, (date, catalog) => {
        const dayFrame = resolveDayFrame(date, "UTC");
        const baseInput = {
          dayFrame,
          now: 0,
          catalog,
          existing: [],
          carryIn: [],
          event: { type: "GENERATE_DAY" as const },
        };
        const r1 = solve(baseInput);
        const r2 = solve(baseInput);
        // Status and instance placements must match exactly.
        if (r1.status !== r2.status) return false;
        if (r1.timeline.instances.length !== r2.timeline.instances.length) return false;
        for (let i = 0; i < r1.timeline.instances.length; i++) {
          const a = r1.timeline.instances[i];
          const b = r2.timeline.instances[i];
          if (a.id !== b.id) return false;
          if (a.plannedStart !== b.plannedStart) return false;
          if (a.plannedEnd !== b.plannedEnd) return false;
          if (a.state !== b.state) return false;
          if (a.scheduledMinutes !== b.scheduledMinutes) return false;
        }
        return true;
      }),
      { numRuns: 1000, endOnFailure: true },
    );
  });

  it("invariants: every generated result passes checkInvariants", () => {
    fc.assert(
      fc.property(dateArb, catalogArb, (date, catalog) => {
        const dayFrame = resolveDayFrame(date, "UTC");
        const result = solve({
          dayFrame,
          now: 0,
          catalog,
          existing: [],
          carryIn: [],
          event: { type: "GENERATE_DAY" },
        });
        // Only check non-rejected results; rejected ones return input unchanged
        // (which would routinely trip on PLANNED-but-past-time instances).
        if (result.status === "REJECTED") return true;
        const violations = checkInvariants(result.timeline);
        return violations.length === 0;
      }),
      { numRuns: 1000, endOnFailure: true },
    );
  });
});
