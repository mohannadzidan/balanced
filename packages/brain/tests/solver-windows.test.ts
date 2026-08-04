import { describe, expect, it } from "vitest"

import { DEFAULT_COST_CONSTANTS } from "../src/engine/constants"
import { priorityWeight } from "../src/engine/cost"
import { solveChecked as solve } from "./support/solve-checked"
import { resolveDayFrame } from "../src/engine/time"
import { activity } from "./support/fixtures"
import { expectPlacements } from "./support/expect-placements"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")
const C = DEFAULT_COST_CONSTANTS

function generate(catalog: ReturnType<typeof activity>[]) {
  return solve({
    dayFrame,
    now: 0,
    catalog: catalog.map((b) => b.build()),
    existing: [],
    carryIn: [],
    event: { type: "GENERATE_DAY" },
  })
}

describe("solve — StrictWindowRule", () => {
  it("places a mandatory strict-window activity in its window ahead of higher-priority optional work", () => {
    const result = generate([
      activity("Optional").rank(1).minutes(500),
      activity("Gym").rank(2).minutes(60).mandatory().strict("09:00", "10:00"),
    ])
    expectPlacements(result, {
      Gym: "09:00-10:00",
      Optional: "00:00-08:20",
    })
    expect(result.status).toBe("OK")
  })

  it("skips WINDOW_UNSATISFIABLE when the window is too small for the duration", () => {
    const result = generate([
      activity("Work").rank(1).minutes(90).strict("09:00", "09:30"),
    ])
    expectPlacements(result, { Work: "SKIPPED" })
  })
})

describe("solve — FlexibleWindowRule", () => {
  it("drifts past its window when a fixed block eats into it, and records the relaxation", () => {
    // Window 19:00-20:30 (90m). A 19:00-19:45 meeting leaves only 45 of the
    // 90 minutes inside the window — Dinner (60m) must drift 15m past 20:30.
    const result = generate([
      activity("Meeting").rank(1).minutes(45).fixed("19:00", "19:45"),
      activity("Dinner")
        .rank(2)
        .minutes(60)
        .flexible("19:00", "20:30", { drift: 30 }),
    ])

    expectPlacements(result, {
      Meeting: "19:00-19:45",
      Dinner: "19:45-20:45",
    })

    const dinner = result.timeline.instances.find((i) => i.name === "Dinner")!
    expect(dinner.relaxations).toEqual([{ type: "drift", minutes: 15 }])

    const weight = priorityWeight(2, 2)
    expect(result.cost.drift).toBe(weight * C.DRIFT * 15)
  })

  it("skips DRIFT_EXCEEDED when even the best drift is over the allowance", () => {
    const result = generate([
      activity("Dinner")
        .rank(1)
        .minutes(120)
        .flexible("19:00", "20:00", { drift: 10 }),
    ])
    expectPlacements(result, { Dinner: "SKIPPED" })
  })
})
