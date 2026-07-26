import { describe, expect, it } from "vitest"

import {
  enumerateCandidateStarts,
  placeActivity,
} from "@/app/brain/engine/placement"
import { activity } from "./support/fixtures"

describe("enumerateCandidateStarts", () => {
  it("enumerates every grid-aligned start that fits the duration", () => {
    expect(enumerateCandidateStarts(30, [{ start: 0, end: 100 }], 5)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70,
    ])
  })

  it("rounds a non-grid-aligned interval start up to the grid", () => {
    expect(enumerateCandidateStarts(10, [{ start: 3, end: 20 }], 5)).toEqual([
      5, 10,
    ])
  })

  it("returns nothing when the interval is shorter than the duration", () => {
    expect(enumerateCandidateStarts(60, [{ start: 0, end: 30 }], 5)).toEqual([])
  })
})

describe("placeActivity — v0 (duration and priority only)", () => {
  it("places at the earliest legal start", () => {
    const a = activity("Work").rank(1).minutes(60).build()
    const result = placeActivity(a, {
      freeIntervals: [{ start: 0, end: 1440 }],
      freezeBoundary: 0,
      grid: 5,
      lengthMinutes: 1440,
    })
    expect(result).toEqual({
      placement: { start: 0, end: 60, nestedIn: null },
      skipReason: null,
    })
  })

  it("never starts before the freeze boundary", () => {
    const a = activity("Work").rank(1).minutes(60).build()
    const result = placeActivity(a, {
      freeIntervals: [{ start: 0, end: 1440 }],
      freezeBoundary: 50,
      grid: 5,
      lengthMinutes: 1440,
    })
    expect(result.placement).toEqual({ start: 50, end: 110, nestedIn: null })
  })

  it("reports NO_FREE_SPACE when nothing fits", () => {
    const a = activity("Work").rank(1).minutes(60).build()
    const result = placeActivity(a, {
      freeIntervals: [{ start: 0, end: 30 }],
      freezeBoundary: 0,
      grid: 5,
      lengthMinutes: 1440,
    })
    expect(result).toEqual({ placement: null, skipReason: "NO_FREE_SPACE" })
  })
})
