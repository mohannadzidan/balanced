import { describe, expect, it } from "vitest"

import { freeGaps, gapsWithinWindow, intersectRange } from "@/lib/solver/gaps"

describe("freeGaps", () => {
  it("returns the whole day when nothing is occupied", () => {
    expect(freeGaps([])).toEqual([{ startMin: 0, endMin: 1440 }])
  })

  it("carves a single occupied range out of the day", () => {
    expect(freeGaps([{ startMin: 600, endMin: 660 }])).toEqual([
      { startMin: 0, endMin: 600 },
      { startMin: 660, endMin: 1440 },
    ])
  })

  it("merges overlapping and out-of-order occupied ranges", () => {
    const gaps = freeGaps([
      { startMin: 700, endMin: 800 },
      { startMin: 600, endMin: 720 },
    ])
    expect(gaps).toEqual([
      { startMin: 0, endMin: 600 },
      { startMin: 800, endMin: 1440 },
    ])
  })

  it("clamps a range that spans past the day boundary", () => {
    expect(freeGaps([{ startMin: 1400, endMin: 1500 }])).toEqual([{ startMin: 0, endMin: 1400 }])
  })

  it("leaves no gap when the day is fully occupied", () => {
    expect(freeGaps([{ startMin: 0, endMin: 1440 }])).toEqual([])
  })
})

describe("intersectRange", () => {
  it("returns the overlap of two ranges", () => {
    expect(intersectRange({ startMin: 100, endMin: 200 }, { startMin: 150, endMin: 250 })).toEqual({
      startMin: 150,
      endMin: 200,
    })
  })

  it("returns null for touching ranges (no positive overlap)", () => {
    expect(intersectRange({ startMin: 100, endMin: 200 }, { startMin: 200, endMin: 300 })).toBeNull()
  })
})

describe("gapsWithinWindow", () => {
  it("passes gaps through unchanged when window is null", () => {
    const gaps = [{ startMin: 0, endMin: 100 }]
    expect(gapsWithinWindow(gaps, null)).toEqual(gaps)
  })

  it("clips gaps to the window and drops non-overlapping ones", () => {
    const gaps = [
      { startMin: 0, endMin: 100 },
      { startMin: 500, endMin: 600 },
    ]
    expect(gapsWithinWindow(gaps, { startMin: 50, endMin: 550 })).toEqual([
      { startMin: 50, endMin: 100 },
      { startMin: 500, endMin: 550 },
    ])
  })
})
