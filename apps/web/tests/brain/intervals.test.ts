import { describe, expect, it } from "vitest"

import {
  computeFreeIntervals,
  intervalContains,
  intervalLength,
  intervalsOverlap,
  subtractIntervals,
} from "@/app/brain/engine/intervals"

describe("computeFreeIntervals", () => {
  it("returns the whole range when nothing is occupied", () => {
    expect(computeFreeIntervals([], 0, 1440)).toEqual([{ start: 0, end: 1440 }])
  })

  it("returns nothing when fully occupied", () => {
    expect(computeFreeIntervals([{ start: 0, end: 1440 }], 0, 1440)).toEqual([])
  })

  it("finds the gaps between occupied blocks", () => {
    const occupied = [
      { start: 540, end: 600 },
      { start: 720, end: 780 },
    ]
    expect(computeFreeIntervals(occupied, 0, 1440)).toEqual([
      { start: 0, end: 540 },
      { start: 600, end: 720 },
      { start: 780, end: 1440 },
    ])
  })

  it("merges overlapping and touching occupied intervals", () => {
    const occupied = [
      { start: 100, end: 200 },
      { start: 150, end: 250 },
      { start: 250, end: 300 },
    ]
    expect(computeFreeIntervals(occupied, 0, 400)).toEqual([
      { start: 0, end: 100 },
      { start: 300, end: 400 },
    ])
  })

  it("clips occupied intervals to the requested range", () => {
    const occupied = [
      { start: -100, end: 50 },
      { start: 1400, end: 2000 },
    ]
    expect(computeFreeIntervals(occupied, 0, 1440)).toEqual([
      { start: 50, end: 1400 },
    ])
  })

  it("ignores occupied intervals entirely outside the range", () => {
    const occupied = [{ start: -100, end: -10 }]
    expect(computeFreeIntervals(occupied, 0, 100)).toEqual([
      { start: 0, end: 100 },
    ])
  })

  it("returns nothing for an inverted range", () => {
    expect(computeFreeIntervals([], 100, 50)).toEqual([])
  })

  it("breaks a same-start sort tie by the earlier end (merge order shouldn't depend on input order)", () => {
    const occupied = [
      { start: 100, end: 300 },
      { start: 100, end: 150 },
    ]
    expect(computeFreeIntervals(occupied, 0, 400)).toEqual([
      { start: 0, end: 100 },
      { start: 300, end: 400 },
    ])
  })
})

describe("intervalsOverlap", () => {
  it.each([
    [
      "disjoint, a before b",
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      false,
    ],
    [
      "disjoint, b before a",
      { start: 20, end: 30 },
      { start: 0, end: 10 },
      false,
    ],
    ["partial overlap", { start: 0, end: 15 }, { start: 10, end: 20 }, true],
    ["fully nested", { start: 5, end: 10 }, { start: 0, end: 20 }, true],
    ["identical", { start: 0, end: 10 }, { start: 0, end: 10 }, true],
  ])("%s", (_label, a, b, expected) => {
    expect(intervalsOverlap(a, b)).toBe(expected)
  })
})

describe("intervalContains", () => {
  it("is true when inner lies entirely within outer", () => {
    expect(
      intervalContains({ start: 0, end: 100 }, { start: 10, end: 20 })
    ).toBe(true)
  })

  it("is true for exact boundary equality", () => {
    expect(
      intervalContains({ start: 0, end: 100 }, { start: 0, end: 100 })
    ).toBe(true)
  })

  it("is false when inner spills past outer", () => {
    expect(
      intervalContains({ start: 0, end: 100 }, { start: 90, end: 110 })
    ).toBe(false)
  })
})

describe("intervalLength", () => {
  it("computes duration", () => {
    expect(intervalLength({ start: 100, end: 160 })).toBe(60)
  })
})

describe("subtractIntervals", () => {
  it("removes covered sub-ranges from a base interval", () => {
    const base = { start: 0, end: 100 }
    const subtract = [{ start: 20, end: 40 }]
    expect(subtractIntervals(base, subtract)).toEqual([
      { start: 0, end: 20 },
      { start: 40, end: 100 },
    ])
  })
})
