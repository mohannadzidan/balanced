import { describe, expect, it } from "vitest"

import { renderAscii } from "@/app/brain/engine/render"
import { solveChecked as solve } from "@/tests/brain/support/solve-checked"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"
import { expectPlacements } from "./support/expect-placements"

const dayFrame = resolveDayFrame("2024-06-17", "UTC") // a Monday

describe("solve — v0 (duration and priority only)", () => {
  it("packs five same-length activities back to back in rank order", () => {
    const catalog = [
      activity("A").rank(1).minutes(60).build(),
      activity("B").rank(2).minutes(60).build(),
      activity("C").rank(3).minutes(60).build(),
      activity("D").rank(4).minutes(60).build(),
      activity("E").rank(5).minutes(60).build(),
    ]

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    expectPlacements(result, {
      A: "00:00-01:00",
      B: "01:00-02:00",
      C: "02:00-03:00",
      D: "03:00-04:00",
      E: "04:00-05:00",
    })
  })

  it("skips an activity once the day is completely full", () => {
    const catalog = [
      activity("Everything").rank(1).minutes(1440).build(),
      activity("Leftover").rank(2).minutes(30).build(),
    ]

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    // A 1440-minute block ending exactly at the day boundary wraps to 00:00
    // under mod-1440 formatting.
    expectPlacements(result, {
      Everything: "00:00-00:00",
      Leftover: "SKIPPED",
    })
  })

  it("honours allowedDays, filtering out activities not scheduled today", () => {
    const catalog = [
      activity("Weekday Only").rank(1).minutes(30).days("MON").build(),
      activity("Weekend Only").rank(2).minutes(30).days("SAT", "SUN").build(),
    ]

    // dayFrame is a Monday.
    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    expect(result.timeline.instances.map((i) => i.name)).toEqual([
      "Weekday Only",
    ])
  })

  it("ignores disabled activities entirely", () => {
    const catalog = [activity("Off").rank(1).minutes(30).disabled().build()]

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    expect(result.timeline.instances).toEqual([])
  })

  it("renders a deterministic ASCII snapshot of the baseline day", () => {
    const catalog = [
      activity("Work").rank(1).minutes(480).build(),
      activity("Gym").rank(2).minutes(60).build(),
    ]

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    expect(renderAscii(result.timeline)).toMatchSnapshot()
  })
})
