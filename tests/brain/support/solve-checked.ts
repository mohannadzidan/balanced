// Test helper that wraps solve() with invariant checking.
// SPEC.md §16.1 layer 4: "route every test through the checkInvariants helper"

import { solve } from "@/app/brain/brain"
import { checkInvariants } from "@/app/brain/engine/invariants"
import type { SolveInput, SolveResult } from "@/app/brain/engine/types"

/**
 * Wrapper around solve() that asserts all structural invariants hold on the result.
 * Throws (via expect) if any invariant is violated.
 * Used in place of bare solve() in scenario tests to get invariant coverage for free.
 *
 * Rejected results (status === "REJECTED") return the input unchanged, so invariants
 * are not checked against them — they would routinely trip on PLANNED-but-past-time
 * instances that backdating never got to run on.
 */
export function solveChecked(input: SolveInput): SolveResult {
  const result = solve(input)

  if (result.status === "REJECTED") {
    return result
  }

  // Check invariants on the main timeline
  const violations = checkInvariants(result.timeline)
  if (violations.length > 0) {
    const messages = violations.map(
      (v) => `[${v.code}] ${v.message} (ids: ${v.instanceIds.join(", ")})`
    )
    throw new Error(
      `Invariant violations in solveChecked result:\n${messages.join("\n")}`
    )
  }

  // Also check bestEffortTimeline if a rejection occurred
  if (result.rejection?.bestEffortTimeline) {
    const beViolations = checkInvariants(result.rejection.bestEffortTimeline)
    if (beViolations.length > 0) {
      const messages = beViolations.map(
        (v) => `[${v.code}] ${v.message} (ids: ${v.instanceIds.join(", ")})`
      )
      throw new Error(
        `Invariant violations in bestEffortTimeline:\n${messages.join("\n")}`
      )
    }
  }

  return result
}
