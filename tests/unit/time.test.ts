import { describe, it, expect } from "vitest"
import {
  MAX_MINUTE_OF_DAY,
  MINUTES_PER_DAY,
  durationMin,
  formatHHMM,
  isMinuteOfDay,
  parseHHMM,
  rangeContains,
  rangesOverlap,
  todayISO,
} from "../../lib/time"

describe("parseHHMM", () => {
  it("parses midnight to 0", () => {
    expect(parseHHMM("00:00")).toBe(0)
  })

  it("parses the last minute of the day to 1439", () => {
    expect(parseHHMM("23:59")).toBe(MAX_MINUTE_OF_DAY)
  })

  it("parses a mid-day time", () => {
    expect(parseHHMM("09:30")).toBe(570)
    expect(parseHHMM("12:00")).toBe(720)
  })

  it("accepts a single-digit hour", () => {
    expect(parseHHMM("9:05")).toBe(545)
  })

  it("trims surrounding whitespace", () => {
    expect(parseHHMM("  08:15  ")).toBe(495)
  })

  it("returns null for an empty string", () => {
    expect(parseHHMM("")).toBeNull()
  })

  it("returns null for non-numeric input", () => {
    expect(parseHHMM("abc")).toBeNull()
  })

  it("returns null for an out-of-range hour", () => {
    expect(parseHHMM("24:00")).toBeNull()
  })

  it("returns null for an out-of-range minute", () => {
    expect(parseHHMM("12:60")).toBeNull()
  })

  it("returns null when the separator is missing", () => {
    expect(parseHHMM("1230")).toBeNull()
  })

  it("returns null for a single-digit minute", () => {
    expect(parseHHMM("12:5")).toBeNull()
  })
})

describe("formatHHMM", () => {
  it("formats 0 as midnight", () => {
    expect(formatHHMM(0)).toBe("00:00")
  })

  it("formats 1439 as the last minute of the day", () => {
    expect(formatHHMM(MAX_MINUTE_OF_DAY)).toBe("23:59")
  })

  it("zero-pads both hours and minutes", () => {
    expect(formatHHMM(65)).toBe("01:05")
    expect(formatHHMM(5)).toBe("00:05")
    expect(formatHHMM(600)).toBe("10:00")
  })
})

describe("parseHHMM / formatHHMM round-trips", () => {
  it("round-trips strings back to themselves", () => {
    for (const value of ["00:00", "01:05", "09:30", "12:00", "23:59"]) {
      expect(formatHHMM(parseHHMM(value) as number)).toBe(value)
    }
  })

  it("round-trips minute values back to themselves", () => {
    for (const value of [0, 1, 65, 570, 720, MAX_MINUTE_OF_DAY]) {
      expect(parseHHMM(formatHHMM(value))).toBe(value)
    }
  })

  it("round-trips every minute of the day", () => {
    for (let minute = 0; minute < MINUTES_PER_DAY; minute++) {
      expect(parseHHMM(formatHHMM(minute))).toBe(minute)
    }
  })
})

describe("durationMin", () => {
  it("returns the length of a normal range", () => {
    expect(durationMin(540, 600)).toBe(60)
    expect(durationMin(0, MAX_MINUTE_OF_DAY)).toBe(1439)
  })

  it("returns 0 for an empty range", () => {
    expect(durationMin(600, 600)).toBe(0)
  })

  it("returns a negative length for a reversed range", () => {
    expect(durationMin(600, 540)).toBe(-60)
  })
})

describe("isMinuteOfDay", () => {
  it("accepts the boundary values", () => {
    expect(isMinuteOfDay(0)).toBe(true)
    expect(isMinuteOfDay(MAX_MINUTE_OF_DAY)).toBe(true)
  })

  it("accepts a value inside the range", () => {
    expect(isMinuteOfDay(720)).toBe(true)
  })

  it("rejects values outside the range", () => {
    expect(isMinuteOfDay(-1)).toBe(false)
    expect(isMinuteOfDay(MINUTES_PER_DAY)).toBe(false)
  })

  it("rejects non-integers", () => {
    expect(isMinuteOfDay(12.5)).toBe(false)
    expect(isMinuteOfDay(Number.NaN)).toBe(false)
    expect(isMinuteOfDay(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe("rangesOverlap", () => {
  it("is true for a genuine intersection", () => {
    expect(
      rangesOverlap(
        { startMin: 540, endMin: 660 },
        { startMin: 600, endMin: 720 }
      )
    ).toBe(true)
  })

  it("is true regardless of argument order", () => {
    expect(
      rangesOverlap(
        { startMin: 600, endMin: 720 },
        { startMin: 540, endMin: 660 }
      )
    ).toBe(true)
  })

  it("is false when the first range ends where the second starts", () => {
    expect(
      rangesOverlap(
        { startMin: 540, endMin: 600 },
        { startMin: 600, endMin: 660 }
      )
    ).toBe(false)
  })

  it("is false when the second range ends where the first starts", () => {
    expect(
      rangesOverlap(
        { startMin: 600, endMin: 660 },
        { startMin: 540, endMin: 600 }
      )
    ).toBe(false)
  })

  it("is false for fully disjoint ranges", () => {
    expect(
      rangesOverlap({ startMin: 0, endMin: 60 }, { startMin: 600, endMin: 660 })
    ).toBe(false)
  })

  it("is true when one range fully contains the other", () => {
    expect(
      rangesOverlap(
        { startMin: 480, endMin: 720 },
        { startMin: 540, endMin: 600 }
      )
    ).toBe(true)
    expect(
      rangesOverlap(
        { startMin: 540, endMin: 600 },
        { startMin: 480, endMin: 720 }
      )
    ).toBe(true)
  })
})

describe("rangeContains", () => {
  it("is true when the inner range is strictly inside", () => {
    expect(
      rangeContains(
        { startMin: 480, endMin: 720 },
        { startMin: 540, endMin: 600 }
      )
    ).toBe(true)
  })

  it("is true for identical ranges", () => {
    expect(
      rangeContains(
        { startMin: 480, endMin: 720 },
        { startMin: 480, endMin: 720 }
      )
    ).toBe(true)
  })

  it("is true when the ranges share one endpoint", () => {
    expect(
      rangeContains(
        { startMin: 480, endMin: 720 },
        { startMin: 480, endMin: 600 }
      )
    ).toBe(true)
    expect(
      rangeContains(
        { startMin: 480, endMin: 720 },
        { startMin: 600, endMin: 720 }
      )
    ).toBe(true)
  })

  it("is false when the inner range starts before the outer", () => {
    expect(
      rangeContains(
        { startMin: 480, endMin: 720 },
        { startMin: 420, endMin: 600 }
      )
    ).toBe(false)
  })

  it("is false when the inner range ends after the outer", () => {
    expect(
      rangeContains(
        { startMin: 480, endMin: 720 },
        { startMin: 600, endMin: 780 }
      )
    ).toBe(false)
  })

  it("is false when the inner range is disjoint", () => {
    expect(
      rangeContains({ startMin: 480, endMin: 720 }, { startMin: 0, endMin: 60 })
    ).toBe(false)
  })
})

describe("todayISO", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("reflects the local calendar date", () => {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const day = String(now.getDate()).padStart(2, "0")
    expect(todayISO()).toBe(`${year}-${month}-${day}`)
  })
})
