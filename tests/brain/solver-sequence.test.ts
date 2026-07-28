import { describe, expect, it } from "vitest"

import { DEFAULT_COST_CONSTANTS } from "@/app/brain/engine/constants"
import { priorityWeight } from "@/app/brain/engine/cost"
import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
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

describe("solve — SequenceRule", () => {
  it("places a pre-dependent immediately before its mandatory strict-window host", () => {
    const result = generate([
      activity("Work").rank(1).minutes(60).mandatory().strict("09:00", "10:00"),
      activity("Commute").rank(2).minutes(30).sequence("pre", "work"),
    ])
    expectPlacements(result, {
      Work: "09:00-10:00",
      Commute: "08:30-09:00",
    })
  })

  it("places a post-dependent immediately after its host", () => {
    const result = generate([
      activity("Work").rank(1).minutes(60).mandatory().strict("09:00", "10:00"),
      activity("Commute")
        .id("commute-home")
        .rank(2)
        .minutes(30)
        .sequence("post", "work"),
    ])
    expectPlacements(result, {
      Work: "09:00-10:00",
      Commute: "10:00-10:30",
    })
  })

  it("skips the dependent with HOST_SKIPPED at zero cost when the host is skipped", () => {
    // Work is optional (not mandatory) and its window is unsatisfiable
    // against the day, so it is skipped — Commute must not be scheduled
    // just to preserve the sequence relationship.
    const result = generate([
      activity("Work").rank(1).minutes(90).strict("09:00", "09:30"),
      activity("Commute").rank(2).minutes(30).sequence("pre", "work"),
    ])
    expectPlacements(result, { Work: "SKIPPED", Commute: "SKIPPED" })

    const commute = result.timeline.instances.find((i) => i.name === "Commute")!
    expect(commute.skipReason).toBe("HOST_SKIPPED")

    // Dependent skip costs nothing, unlike an ordinary optional skip.
    const weight = priorityWeight(2, 2)
    expect(result.cost.skip).not.toBe(weight * C.SKIP)
    expect(result.cost.perInstance["commute@2024-06-17#1"]).toBe(0)
  })

  it("pays the sequence gap cost when the tight slot is unavailable", () => {
    // Work: 09:00-10:00. A fixed meeting occupies 08:45-09:00, so the zero-
    // and 5/10-minute-gap slots for Commute (pre, 15m) all overrun into the
    // meeting; the first that fits entirely before it is a 15m gap.
    const result = generate([
      activity("Work").rank(1).minutes(60).mandatory().strict("09:00", "10:00"),
      activity("Meeting").rank(2).minutes(15).fixed("08:45", "09:00"),
      activity("Commute")
        .rank(3)
        .minutes(15)
        .sequence("pre", "work", { maxGap: 30 }),
    ])
    expectPlacements(result, {
      Work: "09:00-10:00",
      Meeting: "08:45-09:00",
      Commute: "08:30-08:45",
    })
    const commute = result.timeline.instances.find((i) => i.name === "Commute")!
    expect(commute.relaxations).toEqual([{ type: "gap", minutes: 15 }])
  })

  it("resolves a chain: A pre B, B pre C", () => {
    const result = generate([
      activity("C").rank(1).minutes(60).mandatory().strict("10:00", "11:00"),
      activity("B").rank(2).minutes(20).sequence("pre", "c"),
      activity("A").rank(3).minutes(10).sequence("pre", "b"),
    ])
    expectPlacements(result, {
      C: "10:00-11:00",
      B: "09:40-10:00",
      A: "09:30-09:40",
    })
  })
})
