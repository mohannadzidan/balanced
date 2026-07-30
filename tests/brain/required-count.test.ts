// SPEC-v2.1 §6.3 / §15 row 5: requiredCount > 1 (Drop 1 cap) is now allowed.
// The §15 row 5 done-when — "A 30-day frame with daily required activities
// solves inside the node limit" — exercises the union-find decomposition:
// thirty required occurrences of the same daily window form one component
// (every candidate overlaps every other), so the single search has to
// succeed inside the node budget. A second activity with a non-overlapping
// window would form a second component; here we test both ends.

import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "@/tests/brain/support/solve-checked"
import { resolveFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"
import { DEFAULT_COST_CONSTANTS } from "@/app/brain/engine/constants"
import { validateActivity } from "@/app/brain/engine/validation"

const C = DEFAULT_COST_CONSTANTS

describe("SPEC-v2.1 §15 row 5: requiredCount > 1 with hard-set decomposition", () => {
  it("30-day frame with daily required activities solves inside the node limit", () => {
    const frame = resolveFrame("2026-07-01", 30, "UTC")
    // Daily standup, 15 minutes, 09:00 every day, one occurrence per day,
    // each occurrence mandatory. 30 days × 1 occurrence = 30 required
    // nodes; with disjoint day-buckets the union-find places them in one
    // component (their fixed windows all share the 09:00 line) of 30
    // items, which the bounded search must resolve under nodeLimit.
    const standup = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .repeat({ count: 1, period: "day", sharedBudget: false })
      .mandatory()
      .build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [standup],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    if (result.status === "REJECTED") {
      throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`)
    }

    // Every day got exactly one 09:00–09:15 standup.
    const placed = result.timeline.instances.filter(
      (i) => i.name === "Standup" && i.state === "PLANNED"
    )
    expect(placed).toHaveLength(30)
    for (const p of placed) {
      expect(p.plannedStart).not.toBeNull()
      expect(p.plannedEnd! - p.plannedStart!).toBe(15)
    }
  })

  it("requiredCount > count is flagged REQUIRED_COUNT_INVALID", () => {
    const gym = activity("Gym").rank(1).minutes(60).build()
    const withTooMany = {
      ...gym,
      requiredCount: 4,
      rules: [
        ...gym.rules,
        {
          type: "repeat" as const,
          source: "template" as const,
          period: "week" as const,
          count: 3,
          sharedBudget: false,
          minSeparationMinutes: 0,
        },
      ],
    }
    const codes = validateActivity(withTooMany, C).map((i) => i.code)
    expect(codes).toContain("REQUIRED_COUNT_INVALID")
  })

  it("requiredCount within [0, count] is allowed", () => {
    const gym = activity("Gym").rank(1).minutes(60).build()
    const withMaxRequired = {
      ...gym,
      requiredCount: 3,
      rules: [
        ...gym.rules,
        {
          type: "repeat" as const,
          source: "template" as const,
          period: "week" as const,
          count: 3,
          sharedBudget: false,
          minSeparationMinutes: 0,
        },
      ],
    }
    const codes = validateActivity(withMaxRequired, C).map((i) => i.code)
    expect(codes).not.toContain("REQUIRED_COUNT_INVALID")
  })
})
