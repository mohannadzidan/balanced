// SPEC-v2.1 §15 row 8 / §3.2 + §3.3 done-when: "Frame.defaultDayWindow
// confines an unwindowed activity to the implicit daily window every day
// across a multi-day frame; Frame.backdateHorizonMinutes turns blocks
// sufficiently far before `now` into LAPSED instead of COMPLETED."

import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/brain"
import { resolveFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

describe("SPEC-v2.1 §3.2: Frame.defaultDayWindow", () => {
  it("an unwindowed 60-minute activity over a 7-day frame lands inside the implicit daily window every day", () => {
    const frame = {
      ...resolveFrame("2026-07-27", 7, "UTC"),
      // 09:00–17:00 daily: without this the activity would land at 00:00
      // day 0 (SPEC-v2.1 §3.2's "actively bad" outcome). The window
      // resolves per day so each day's placement must start ≥ 09:00.
      defaultDayWindow: { startWall: "09:00", endWall: "17:00" },
    }

    const reading = activity("Reading").rank(1).minutes(60).build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [reading],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    expect(result.status).not.toBe("REJECTED")

    const planned = result.timeline.instances.filter(
      (i) => i.name === "Reading"
    )
    expect(planned).toHaveLength(7)

    for (let i = 0; i < 7; i++) {
      const dayStart = i * 1440 + 9 * 60
      const p = planned[i]
      expect(p.date).toBe(frame.days[i].date)
      expect(p.plannedStart).toBeGreaterThanOrEqual(dayStart)
      expect(p.plannedStart).toBeLessThan(dayStart + (17 - 9) * 60)
    }
  })

  it("with no defaultDayWindow, an unwindowed activity over a 7-day frame still lands (v1 behavior)", () => {
    const frame = resolveFrame("2026-07-27", 7, "UTC")
    const reading = activity("Reading").rank(1).minutes(60).build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [reading],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    expect(result.status).not.toBe("REJECTED")
    expect(
      result.timeline.instances.filter((i) => i.name === "Reading")
    ).toHaveLength(7)
  })
})

describe("SPEC-v2.1 §3.3: Frame.backdateHorizonMinutes", () => {
  it("a block ending well before `now` is marked SKIPPED (LAPSED) instead of COMPLETED when horizon caps it", () => {
    const frame = {
      ...resolveFrame("2026-07-27", 30, "UTC"),
      // 2 days = 2880 minutes. A standup at 09:00 day 5 has plannedEnd
      // = 4*1440 + 9*60 + 15 = 5775. With now=7200 (mid-day 5), the
      // standup's end is 7200 - 5775 = 1425 minutes before `now`, well
      // over the 2880-minute horizon's *negative* budget — but wait, the
      // condition is `inst.plannedEnd < now - horizonMinutes`, so a small
      // horizon relative to (now - plannedEnd) trips the LAPSED branch.
      // Use a 1-minute horizon so anything past it lapses.
      backdateHorizonMinutes: 1,
    }

    const standup = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .build()

    // Solve once at now=0 to seed 30 day-1-style standups across 30 days.
    const seeded = solve({
      dayFrame: frame,
      now: 0,
      catalog: [standup],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    expect(seeded.status).not.toBe("REJECTED")
    expect(
      seeded.timeline.instances.filter((i) => i.name === "Standup")
    ).toHaveLength(30)

    // TICK at now=10*1440 + 9*60 = 14580 (mid-day 10). With a 1-minute
    // horizon, every standup whose plannedEnd < 14580 - 1 = 14579 lapses.
    // The earliest standup is at 09:15 day 0 = 555 (well before 14579),
    // so all but today's standup should LAPSED.
    const ticked = solve({
      dayFrame: frame,
      now: 14580,
      catalog: [standup],
      existing: seeded.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: seeded.timeline.revision,
    })
    expect(ticked.status).not.toBe("REJECTED")

    const lapsed = ticked.timeline.instances.filter(
      (i) =>
        i.name === "Standup" &&
        i.state === "SKIPPED" &&
        i.skipReason === "LAPSED"
    )
    const completed = ticked.timeline.instances.filter(
      (i) => i.name === "Standup" && i.state === "COMPLETED"
    )
    expect(lapsed.length).toBeGreaterThan(0)
    expect(lapsed.length).toBeLessThan(30)
    // The standup at day 10 (the active one) is still PLANNED/ACTIVE.
    expect(completed.length).toBe(0)
  })

  it("with no horizon set, every block before `now` is COMPLETED (v1 behavior)", () => {
    const frame = resolveFrame("2026-07-27", 7, "UTC")
    const standup = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .build()

    const seeded = solve({
      dayFrame: frame,
      now: 0,
      catalog: [standup],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    expect(
      seeded.timeline.instances.filter((i) => i.name === "Standup")
    ).toHaveLength(7)

    const ticked = solve({
      dayFrame: frame,
      now: 5 * 1440 + 9 * 60,
      catalog: [standup],
      existing: seeded.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: seeded.timeline.revision,
    })
    expect(ticked.status).not.toBe("REJECTED")

    const completed = ticked.timeline.instances.filter(
      (i) => i.name === "Standup" && i.state === "COMPLETED"
    )
    const lapsed = ticked.timeline.instances.filter(
      (i) => i.name === "Standup" && i.skipReason === "LAPSED"
    )
    // Days 0–4 are entirely before now → COMPLETED. Day 5 is mid-day →
    // ACTIVE. Day 6 is in the future → PLANNED. None should lapse.
    expect(completed).toHaveLength(5)
    expect(lapsed).toHaveLength(0)
  })
})
