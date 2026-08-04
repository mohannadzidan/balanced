import { describe, expect, it } from "vitest"

import {
  nextRollingTarget,
  nextRollingTargetNoCarryOver,
} from "@/lib/tracking/carryover"

describe("nextRollingTarget", () => {
  it("uses the base target when there is nothing to evaluate yet", () => {
    expect(
      nextRollingTarget({ baseTargetMin: 120, capMin: null, evaluation: null })
    ).toBe(120)
  })

  it("raises the target by yesterday's deficit", () => {
    // 2h target, only 1h achieved -> 1h deficit -> tomorrow is 3h.
    const result = nextRollingTarget({
      baseTargetMin: 120,
      capMin: null,
      evaluation: { achievedMin: 60, expectedMin: 120, wasVacation: false },
    })
    expect(result).toBe(180)
  })

  it("lowers the target by yesterday's surplus", () => {
    // 2h target, 3h achieved -> 1h surplus -> tomorrow is 1h.
    const result = nextRollingTarget({
      baseTargetMin: 120,
      capMin: null,
      evaluation: { achievedMin: 180, expectedMin: 120, wasVacation: false },
    })
    expect(result).toBe(60)
  })

  it("never drops below zero on a large surplus", () => {
    const result = nextRollingTarget({
      baseTargetMin: 60,
      capMin: null,
      evaluation: { achievedMin: 300, expectedMin: 60, wasVacation: false },
    })
    expect(result).toBe(0)
  })

  it("caps a snowballing deficit at the configured maximum", () => {
    const result = nextRollingTarget({
      baseTargetMin: 120,
      capMin: 240,
      evaluation: { achievedMin: 0, expectedMin: 600, wasVacation: false },
    })
    expect(result).toBe(240)
  })

  it("resets to the base target after a vacation day, carrying nothing forward", () => {
    const result = nextRollingTarget({
      baseTargetMin: 120,
      capMin: null,
      evaluation: { achievedMin: 0, expectedMin: 400, wasVacation: true },
    })
    expect(result).toBe(120)
  })
})

describe("nextRollingTargetNoCarryOver", () => {
  it("always returns the base target, capped", () => {
    expect(nextRollingTargetNoCarryOver(500, 240)).toBe(240)
    expect(nextRollingTargetNoCarryOver(90, null)).toBe(90)
  })
})
