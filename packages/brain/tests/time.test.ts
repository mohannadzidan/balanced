import { describe, expect, it } from "vitest"

import {
  resolveDayFrame,
  resolveWallClock,
  resolveWallClockToInstant,
  weekdayOf,
} from "../src/engine/time"

describe("resolveDayFrame", () => {
  it("is 1440 minutes on an ordinary day", () => {
    expect(
      resolveDayFrame("2024-06-15", "America/New_York").lengthMinutes
    ).toBe(1440)
  })

  it("is 1440 minutes for a fixed-offset zone like UTC", () => {
    expect(resolveDayFrame("2024-01-01", "UTC").lengthMinutes).toBe(1440)
  })

  it("is 1380 minutes on the spring-forward day", () => {
    // America/New_York: 2024-03-10, clocks jump 02:00 -> 03:00
    expect(
      resolveDayFrame("2024-03-10", "America/New_York").lengthMinutes
    ).toBe(1380)
  })

  it("is 1500 minutes on the fall-back day", () => {
    // America/New_York: 2024-11-03, clocks fall back 02:00 -> 01:00
    expect(
      resolveDayFrame("2024-11-03", "America/New_York").lengthMinutes
    ).toBe(1500)
  })

  it("computes startInstant as local midnight in UTC", () => {
    const frame = resolveDayFrame("2024-01-01", "UTC")
    expect(frame.startInstant).toBe(Date.UTC(2024, 0, 1, 0, 0, 0))
  })
})

describe("resolveWallClock", () => {
  it("resolves an ordinary time to minutes since midnight", () => {
    const frame = resolveDayFrame("2024-06-15", "America/New_York")
    expect(resolveWallClock("09:00", frame)).toBe(540)
    expect(resolveWallClock("00:00", frame)).toBe(0)
    expect(resolveWallClock("23:55", frame)).toBe(1435)
  })
})

describe("resolveWallClockToInstant — DST edge cases", () => {
  it("resolves an unambiguous time normally", () => {
    const result = resolveWallClockToInstant(
      2024,
      6,
      15,
      9,
      0,
      "America/New_York"
    )
    expect(result.ambiguous).toBe(false)
    expect(result.nonExistent).toBe(false)
  })

  it("resolves a non-existent spring-forward time to the transition instant", () => {
    // 2024-03-10: 02:00 EST -> 03:00 EDT. Transition instant is 07:00 UTC.
    const result = resolveWallClockToInstant(
      2024,
      3,
      10,
      2,
      30,
      "America/New_York"
    )
    expect(result.nonExistent).toBe(true)
    expect(result.instant).toBe(Date.UTC(2024, 2, 10, 7, 0, 0))
  })

  it("resolves an ambiguous fall-back time to its first occurrence", () => {
    // 2024-11-03: 01:30 occurs once at EDT (UTC-4) and once at EST (UTC-5).
    // First occurrence is EDT: 01:30 - (-4h) = 05:30 UTC.
    const result = resolveWallClockToInstant(
      2024,
      11,
      3,
      1,
      30,
      "America/New_York"
    )
    expect(result.ambiguous).toBe(true)
    expect(result.instant).toBe(Date.UTC(2024, 10, 3, 5, 30, 0))
  })
})

describe("weekdayOf", () => {
  it.each([
    ["2024-01-01", "MON"],
    ["2024-01-07", "SUN"],
    ["2024-01-06", "SAT"],
  ])("%s is %s", (date, expected) => {
    expect(weekdayOf(date)).toBe(expected)
  })
})
