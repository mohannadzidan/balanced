// SPEC-v2.1 §6.1 / §15 row 4 done-when: "Mon/Wed/Fri falls out of 3×/week
// at 48h separation, with no spreading heuristic anywhere in the code."
// Pure greedy-earliest produces Mon/Tue/Wed at count: 3, period: "week"
// because each occurrence gets one eligible weekday-only window and the
// day buckets are the only slot. With minSeparationMinutes: 48h, the
// search must reject Mon/Tue/Wed (24h apart) and spread to Wed/Fri (72h
// apart, but the second occurrence is still 48h clear of the first).

import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "@/tests/brain/support/solve-checked"
import { resolveFrame } from "@/app/brain/engine/time"
import type { TimelineActivity } from "@/app/brain/engine/types"
import { activity } from "./support/fixtures"

function plannedByName(
  instances: readonly TimelineActivity[],
  name: string
): TimelineActivity[] {
  return instances
    .filter((i) => i.name === name && i.state === "PLANNED")
    .sort((a, z) => (a.occurrenceIndex ?? 0) - (z.occurrenceIndex ?? 0))
}

describe("SPEC-v2.1 §6.1: minSeparationMinutes drives a Mon/Wed/Fri layout", () => {
  it("3×/week at 48h separation spreads to Mon/Wed/Fri (no spreading code)", () => {
    const frame = resolveFrame("2026-07-27", 7, "UTC") // Mon 2026-07-27 .. Sun 2026-08-02

    // Three separate eligibility windows, one each on Mon/Tue/Wed at the
    // same wall-clock 09:00-10:00 — the search sees three occurrences
    // (count: 3, period: "week") and three eligible slots, but
    // separation forces a real spread.
    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .window("09:00", "10:00", { days: ["MON"] })
      .window("09:00", "10:00", { days: ["TUE"] })
      .window("09:00", "10:00", { days: ["WED"] })
      .window("09:00", "10:00", { days: ["FRI"] })
      .repeat({
        count: 3,
        period: "week",
        sharedBudget: false,
        minSeparationMinutes: 48 * 60,
      })
      .build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [gym],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    if (result.status === "REJECTED") {
      throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`)
    }

    const placed = plannedByName(result.timeline.instances, "Gym")
    expect(placed).toHaveLength(3)

    // Mon/Wed/Fri emerges from the separation filter alone: the original
    // Mon/Tue/Wed layout (24h-spaced siblings) is rejected by the filter,
    // so the bounded-backtracking search lands each occurrence on the
    // next 48h-clear eligible slot — Mon, then Wed (+72h, ≥48h), then
    // Fri (+72h again, ≥48h).
    const dates = placed.map((p) => p.date)
    expect(dates).toEqual(["2026-07-27", "2026-07-29", "2026-07-31"])

    // Hard property: every pair of siblings is ≥ 48h apart, start-to-start.
    const starts = placed.map((p) => p.plannedStart ?? 0)
    for (let i = 0; i < starts.length; i++) {
      for (let j = i + 1; j < starts.length; j++) {
        expect(Math.abs(starts[i] - starts[j])).toBeGreaterThanOrEqual(48 * 60)
      }
    }

    // Bucket key sanity: all three sit in the same ISO week.
    const bucketKeys = new Set(placed.map((p) => p.bucketKey))
    expect(bucketKeys.size).toBe(1)
    expect(bucketKeys.has("2026-W31")).toBe(true)
  })

  it("without separation, the same catalogue falls out Mon/Tue/Wed (the policy this slice is changing)", () => {
    const frame = resolveFrame("2026-07-27", 7, "UTC")
    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .window("09:00", "10:00", { days: ["MON"] })
      .window("09:00", "10:00", { days: ["TUE"] })
      .window("09:00", "10:00", { days: ["WED"] })
      .repeat({ count: 3, period: "week", sharedBudget: false })
      .build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [gym],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    if (result.status === "REJECTED") {
      throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`)
    }
    const placed = plannedByName(result.timeline.instances, "Gym")
    expect(placed.map((p) => p.date)).toEqual(["2026-07-27", "2026-07-28", "2026-07-29"])
  })
})
