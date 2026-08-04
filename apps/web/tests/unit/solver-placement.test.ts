import { describe, expect, it } from "vitest"

import { fillTrackedActivity, placeFlexibleBlock } from "@/lib/solver/placement"

describe("placeFlexibleBlock", () => {
  it("places at the window's own start when the whole window is free", () => {
    const result = placeFlexibleBlock({ startMin: 600, endMin: 660 }, 60, [
      { startMin: 0, endMin: 1440 },
    ])
    expect(result).toEqual({
      block: { startMin: 600, endMin: 660 },
      wasShrunk: false,
    })
  })

  it("floats a shorter duration within wider bounds, anchored to the window's start", () => {
    // An 8h (480m) block inside a 10h (600m) window: 21:00 (1260) to 07:00
    // (420, wrapped) — clamped to today's 1260-1440 portion for this test.
    const result = placeFlexibleBlock({ startMin: 1260, endMin: 1440 }, 120, [
      { startMin: 0, endMin: 1440 },
    ])
    expect(result).toEqual({
      block: { startMin: 1260, endMin: 1380 },
      wasShrunk: false,
    })
  })

  it("slides later within the window when the preferred start is occupied", () => {
    const result = placeFlexibleBlock({ startMin: 600, endMin: 700 }, 40, [
      { startMin: 620, endMin: 700 },
    ])
    expect(result).toEqual({
      block: { startMin: 620, endMin: 660 },
      wasShrunk: false,
    })
  })

  it("shrinks to the largest overlapping gap instead of dropping the activity", () => {
    const result = placeFlexibleBlock({ startMin: 600, endMin: 660 }, 60, [
      { startMin: 610, endMin: 640 },
    ])
    expect(result).toEqual({
      block: { startMin: 610, endMin: 640 },
      wasShrunk: true,
    })
  })

  it("returns null only when the window has no free overlap at all", () => {
    const result = placeFlexibleBlock({ startMin: 600, endMin: 660 }, 60, [
      { startMin: 700, endMin: 800 },
    ])
    expect(result).toBeNull()
  })
})

describe("fillTrackedActivity", () => {
  it("fills the target from a single large gap", () => {
    const result = fillTrackedActivity({
      targetMin: 120,
      minBlockMin: 15,
      window: null,
      gaps: [{ startMin: 0, endMin: 1440 }],
    })
    expect(result.placements).toEqual([{ startMin: 0, endMin: 120 }])
    expect(result.shortfallMin).toBe(0)
  })

  it("spreads across multiple gaps in chronological order", () => {
    const result = fillTrackedActivity({
      targetMin: 90,
      minBlockMin: 15,
      window: null,
      gaps: [
        { startMin: 600, endMin: 630 },
        { startMin: 300, endMin: 360 },
      ],
    })
    expect(result.placements).toEqual([
      { startMin: 300, endMin: 360 },
      { startMin: 600, endMin: 630 },
    ])
    expect(result.shortfallMin).toBe(0)
  })

  it("skips a gap smaller than the minimum block size", () => {
    const result = fillTrackedActivity({
      targetMin: 60,
      minBlockMin: 30,
      window: null,
      gaps: [
        { startMin: 0, endMin: 20 },
        { startMin: 100, endMin: 160 },
      ],
    })
    expect(result.placements).toEqual([{ startMin: 100, endMin: 160 }])
    expect(result.shortfallMin).toBe(0)
  })

  it("reports the full target as shortfall when nothing fits", () => {
    const result = fillTrackedActivity({
      targetMin: 60,
      minBlockMin: 30,
      window: null,
      gaps: [{ startMin: 0, endMin: 10 }],
    })
    expect(result.placements).toEqual([])
    expect(result.shortfallMin).toBe(60)
  })

  it("restricts placement to the given window", () => {
    const result = fillTrackedActivity({
      targetMin: 60,
      minBlockMin: 15,
      window: { startMin: 480, endMin: 540 },
      gaps: [{ startMin: 0, endMin: 1440 }],
    })
    expect(result.placements).toEqual([{ startMin: 480, endMin: 540 }])
    expect(result.shortfallMin).toBe(0)
  })
})
