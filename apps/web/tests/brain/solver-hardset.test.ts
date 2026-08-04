import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "@/tests/brain/support/solve-checked"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"
import { expectPlacements } from "./support/expect-placements"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

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

describe("solve — hard set (Fixed + Mandatory)", () => {
  it("places a fixed activity at its declared time regardless of rank", () => {
    const result = generate([
      activity("Optional").rank(1).minutes(60),
      activity("Meeting").rank(2).minutes(30).fixed("14:00", "14:30"),
    ])
    expectPlacements(result, {
      Meeting: "14:00-14:30",
      // Optional still packs into the earliest remaining free space.
      Optional: "00:00-01:00",
    })
    expect(result.status).toBe("OK")
  })

  it("a mandatory activity is not crowded out by a higher-priority optional one", () => {
    // Two fixed blocks carve the day into exactly two free islands:
    // [0, 100) and [200, 260). Gym (90m, mandatory) fits only the first
    // island. Optional (50m, higher priority, rank 1) fits either. If
    // priority order alone drove placement, Optional would grab the first
    // island's earliest start and leave nothing 90m-wide for Gym. The
    // hard-set phase must place Gym first regardless of rank.
    const result = generate([
      activity("Optional").rank(1).minutes(50),
      activity("Gym").rank(2).minutes(90).mandatory(),
      activity("Blocker1").rank(3).minutes(100).fixed("01:40", "03:20"),
      activity("Blocker2").rank(4).minutes(1180).fixed("04:20", "24:00"),
    ])
    expectPlacements(result, {
      Gym: "00:00-01:30",
      Optional: "03:20-04:10",
      Blocker1: "01:40-03:20",
      Blocker2: "04:20-00:00",
    })
    expect(result.status).toBe("OK")
  })

  it("degrades with a blocking diagnostic when two fixed activities collide", () => {
    const result = generate([
      activity("A").rank(1).minutes(60).fixed("09:00", "10:00"),
      activity("B").rank(2).minutes(60).fixed("09:30", "10:30"),
    ])
    expect(result.status).toBe("DEGRADED")
    expectPlacements(result, { A: "SKIPPED", B: "SKIPPED" })
    expect(result.diagnostics.some((d) => d.code === "FIXED_COLLISION")).toBe(
      true
    )
  })

  it("degrades with a blocking diagnostic when a mandatory activity is unplaceable", () => {
    const result = generate([
      activity("Everything").rank(1).minutes(1440).fixed("00:00", "24:00"),
      activity("Gym").rank(2).minutes(60).mandatory(),
    ])
    expect(result.status).toBe("DEGRADED")
    expectPlacements(result, { Everything: "00:00-00:00", Gym: "SKIPPED" })
    expect(
      result.diagnostics.some((d) => d.code === "INFEASIBLE_HARD_CONSTRAINT")
    ).toBe(true)
  })

  it("an activity can be both Fixed and Mandatory", () => {
    const result = generate([
      activity("Surgery")
        .rank(1)
        .minutes(60)
        .fixed("09:00", "10:00")
        .mandatory(),
    ])
    expectPlacements(result, { Surgery: "09:00-10:00" })
    expect(result.status).toBe("OK")
  })
})
