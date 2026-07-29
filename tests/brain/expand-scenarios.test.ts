// SPEC-v2.1 §15 row 3's exact done-when: "three-times-weekly produces three
// occurrences in the right buckets" — end-to-end through solve(), not just
// expand() in isolation (see expand.test.ts for the pure-function coverage).

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
    .sort((a, b) => (a.occurrenceIndex ?? 0) - (b.occurrenceIndex ?? 0))
}

describe("SPEC-v2.1 §15 row 3: expand() wired into solve() — recurrence (sharedBudget: false)", () => {
  it("three-times-weekly produces three occurrences in the right (week) bucket", () => {
    // Monday 2026-07-27 .. Sunday 2026-08-02, one ISO week (2026-W31).
    const frame = resolveFrame("2026-07-27", 7, "UTC")

    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .window("09:00", "10:00", { days: ["MON"] })
      .window("09:00", "10:00", { days: ["WED"] })
      .window("09:00", "10:00", { days: ["FRI"] })
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

    if (result.status === "REJECTED") throw new Error("unexpected rejection")

    const placed = plannedByName(result.timeline.instances, "Gym")
    expect(placed).toHaveLength(3)

    // Every occurrence bucketed into the same (single) week bucket.
    expect(placed.map((p) => p.bucketKey)).toEqual([
      "2026-W31",
      "2026-W31",
      "2026-W31",
    ])
    expect(placed.map((p) => p.occurrenceIndex)).toEqual([1, 2, 3])

    // Each occurrence's occurrenceId is distinct (SPEC-v2.1 §14 invariant 14).
    const occurrenceIds = new Set(placed.map((p) => p.occurrenceId))
    expect(occurrenceIds.size).toBe(3)

    // With one 60-minute strict window per eligible weekday and no
    // minSeparationMinutes yet (step 4), the three sessions land on three
    // distinct dates — each occurrence's own window is fully occupied by
    // the time the next occurrence is placed.
    const dates = new Set(placed.map((p) => p.date))
    expect(dates.size).toBe(3)
    for (const date of dates) {
      expect(["2026-07-27", "2026-07-29", "2026-07-31"]).toContain(date)
    }
  })

  it("a recurrence RepeatRule with period: 'day' matches Drop 1's per-day behavior at count: 1", () => {
    const frame = resolveFrame("2026-07-27", 3, "UTC") // Mon, Tue, Wed

    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .window("09:00", "10:00", { days: ["MON", "WED"] })
      .repeat({ count: 1, period: "day", sharedBudget: false })
      .build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [gym],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    if (result.status === "REJECTED") throw new Error("unexpected rejection")

    const placed = plannedByName(result.timeline.instances, "Gym")
    expect(placed).toHaveLength(2)
    expect(placed.map((p) => p.bucketKey).sort()).toEqual([
      "2026-07-27",
      "2026-07-29",
    ])
    expect(placed.every((p) => p.occurrenceIndex === 1)).toBe(true)
  })
})

describe("SPEC-v2.1 §7.1: FixedRule resolves per bucket", () => {
  it("a daily standup across a multi-day frame resolves 09:00 against each occurrence's own day, in one solve", () => {
    const frame = resolveFrame("2026-07-27", 5, "UTC") // Mon..Fri

    const standup = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [standup],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    if (result.status === "REJECTED") throw new Error("unexpected rejection")

    const placed = plannedByName(result.timeline.instances, "Standup")
    expect(placed).toHaveLength(5)

    const dates = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]
    expect(placed.map((p) => p.date)).toEqual(dates)
    expect(placed.map((p) => p.bucketKey)).toEqual(dates)

    // Each day's 09:00 resolves against that day's own offset, not day 0's.
    for (let i = 0; i < placed.length; i++) {
      const day = frame.days[i]
      expect(placed[i].plannedStart).toBe(day.startOffset + 9 * 60)
      expect(placed[i].plannedEnd).toBe(day.startOffset + 9 * 60 + 15)
    }

    const occurrenceIds = new Set(placed.map((p) => p.occurrenceId))
    expect(occurrenceIds.size).toBe(5)
  })

  it("a weekly fixed standup (period: 'week') resolves against the one day inside its bucket eligible for it", () => {
    const frame = resolveFrame("2026-07-27", 7, "UTC") // Mon..Sun, one ISO week

    const standup = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .days("MON")
      .repeat({ count: 1, period: "week", sharedBudget: false })
      .build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [standup],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    if (result.status === "REJECTED") throw new Error("unexpected rejection")

    const placed = plannedByName(result.timeline.instances, "Standup")
    expect(placed).toHaveLength(1)
    expect(placed[0].bucketKey).toBe("2026-W31")
    expect(placed[0].date).toBe("2026-07-27")
    expect(placed[0].plannedStart).toBe(frame.days[0].startOffset + 9 * 60)
  })
})
