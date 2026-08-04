import { describe, expect, it } from "vitest"

import { DEFAULT_COST_CONSTANTS } from "../src/engine/constants"
import {
  computeNestableRegions,
  findBestNestedPlacement,
  overlapRuleOf,
  resolveAbsoluteExclusions,
  resolveExclusionWindow,
  usedBudget,
} from "../src/engine/overlap"
import type { PlacementContext } from "../src/engine/placement"
import { resolveActivity } from "../src/engine/resolve"
import { resolveDayFrame } from "../src/engine/time"
import type { ExclusionWindow, OverlapRule } from "../src/engine/types"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")
const C = DEFAULT_COST_CONSTANTS

function baseContext(
  overrides: Partial<PlacementContext> = {}
): PlacementContext {
  return {
    freeIntervals: [{ start: 0, end: 1440 }],
    freezeBoundary: 0,
    grid: 5,
    lengthMinutes: 1440,
    weight: 1,
    constants: C,
    ...overrides,
  }
}

describe("overlapRuleOf", () => {
  it("finds the overlap rule on a host", () => {
    const host = activity("Work")
      .rank(1)
      .minutes(480)
      .overlap({ budget: 60, guests: ["email"] })
      .build()
    expect(overlapRuleOf(host)?.budgetMinutes).toBe(60)
  })

  it("is null for an activity without one", () => {
    const a = activity("Work").rank(1).minutes(60).build()
    expect(overlapRuleOf(a)).toBeNull()
  })
})

describe("resolveExclusionWindow", () => {
  it("resolves a relative window against the host's start", () => {
    const window: ExclusionWindow = {
      id: "focus",
      name: "Focus Hour",
      anchor: "relative",
      startOffset: 60,
      endOffset: 120,
    }
    expect(resolveExclusionWindow(window, { start: 540 }, dayFrame)).toEqual({
      start: 600,
      end: 660,
    })
  })

  it("defaults a relative window's missing offsets to zero", () => {
    const window: ExclusionWindow = {
      id: "focus",
      name: "Focus Hour",
      anchor: "relative",
    }
    expect(resolveExclusionWindow(window, { start: 540 }, dayFrame)).toEqual({
      start: 540,
      end: 540,
    })
  })

  it("defaults an absolute window's missing wall-clock times to midnight", () => {
    const window: ExclusionWindow = {
      id: "call",
      name: "Customer Call",
      anchor: "absolute",
    }
    expect(resolveExclusionWindow(window, { start: 999 }, dayFrame)).toEqual({
      start: 0,
      end: 0,
    })
  })

  it("resolves an absolute window to wall-clock offsets regardless of the host", () => {
    const window: ExclusionWindow = {
      id: "call",
      name: "Customer Call",
      anchor: "absolute",
      startWall: "09:00",
      endWall: "10:00",
    }
    expect(resolveExclusionWindow(window, { start: 999 }, dayFrame)).toEqual({
      start: 540,
      end: 600,
    })
  })
})

describe("resolveAbsoluteExclusions", () => {
  it("returns only the absolute-anchored windows", () => {
    const rule: OverlapRule = {
      type: "overlap",
      source: "template",
      budgetMinutes: 60,
      allowedGuestIds: [],
      exclusionWindows: [
        {
          id: "a",
          name: "Relative",
          anchor: "relative",
          startOffset: 0,
          endOffset: 30,
        },
        {
          id: "b",
          name: "Absolute",
          anchor: "absolute",
          startWall: "09:00",
          endWall: "10:00",
        },
      ],
    }
    expect(resolveAbsoluteExclusions(rule, dayFrame)).toEqual([
      { start: 540, end: 600 },
    ])
  })

  it("returns an empty array for a null rule", () => {
    expect(resolveAbsoluteExclusions(null, dayFrame)).toEqual([])
  })
})

describe("computeNestableRegions", () => {
  it("is the full host span when there are no exclusions or guests", () => {
    const rule: OverlapRule = {
      type: "overlap",
      source: "template",
      budgetMinutes: 60,
      allowedGuestIds: [],
      exclusionWindows: [],
    }
    expect(
      computeNestableRegions({ start: 540, end: 1020 }, rule, [], dayFrame)
    ).toEqual([{ start: 540, end: 1020 }])
  })

  it("subtracts relative exclusion windows and existing guests", () => {
    const rule: OverlapRule = {
      type: "overlap",
      source: "template",
      budgetMinutes: 60,
      allowedGuestIds: [],
      exclusionWindows: [
        {
          id: "focus",
          name: "Focus Hour",
          anchor: "relative",
          startOffset: 60,
          endOffset: 120,
        },
      ],
    }
    const existingGuests = [{ start: 570, end: 590, nestedIn: "work" }]
    // Host 540-1020. Exclusion 600-660. Guest 570-590.
    expect(
      computeNestableRegions(
        { start: 540, end: 1020 },
        rule,
        existingGuests,
        dayFrame
      )
    ).toEqual([
      { start: 540, end: 570 },
      { start: 590, end: 600 },
      { start: 660, end: 1020 },
    ])
  })
})

describe("usedBudget", () => {
  it("sums the scheduled minutes of existing guests", () => {
    const guests = [
      { start: 0, end: 20, nestedIn: "work" },
      { start: 30, end: 45, nestedIn: "work" },
    ]
    expect(usedBudget(guests)).toBe(35)
  })
})

describe("findBestNestedPlacement", () => {
  const rule: OverlapRule = {
    type: "overlap",
    source: "template",
    budgetMinutes: 60,
    allowedGuestIds: ["email"],
    exclusionWindows: [],
  }

  it("places a guest at the earliest legal spot inside the host", () => {
    const email = resolveActivity(
      activity("Email").id("email").rank(5).minutes(30).build(),
      dayFrame
    )
    const found = findBestNestedPlacement(
      email,
      30,
      { start: 540, end: 1020 },
      rule,
      [],
      dayFrame,
      baseContext()
    )
    expect(found?.placement).toEqual({ start: 540, end: 570, nestedIn: null })
    expect(found?.scheduledMinutes).toBe(30)
  })

  it("returns null when the budget is already exhausted", () => {
    const email = resolveActivity(
      activity("Email").id("email").rank(5).minutes(30).build(),
      dayFrame
    )
    const existingGuests = [{ start: 540, end: 600, nestedIn: "work" }] // uses the full 60m budget
    const found = findBestNestedPlacement(
      email,
      30,
      { start: 540, end: 1020 },
      rule,
      existingGuests,
      dayFrame,
      baseContext()
    )
    expect(found).toBeNull()
  })

  it("caps the candidate length to the remaining budget", () => {
    const email = resolveActivity(
      activity("Email").id("email").rank(5).minutes(50).build(),
      dayFrame
    )
    const existingGuests = [{ start: 540, end: 570, nestedIn: "work" }] // 30m used, 30m left
    const found = findBestNestedPlacement(
      email,
      20, // shrink floor
      { start: 540, end: 1020 },
      rule,
      existingGuests,
      dayFrame,
      baseContext()
    )
    expect(found?.scheduledMinutes).toBe(30)
  })

  it("returns null when the remaining budget can't even cover the shrink floor", () => {
    const email = resolveActivity(
      activity("Email").id("email").rank(5).minutes(30).build(),
      dayFrame
    )
    const existingGuests = [{ start: 540, end: 590, nestedIn: "work" }] // 50m used, 10m left
    const found = findBestNestedPlacement(
      email,
      20, // shrink floor: bigger than the 10m of budget left
      { start: 540, end: 1020 },
      rule,
      existingGuests,
      dayFrame,
      baseContext()
    )
    expect(found).toBeNull()
  })

  it("returns null when no region satisfies the guest's own window", () => {
    const email = resolveActivity(
      activity("Email")
        .id("email")
        .rank(5)
        .minutes(30)
        .strict("20:00", "21:00")
        .build(),
      dayFrame
    )
    const found = findBestNestedPlacement(
      email,
      30,
      { start: 540, end: 1020 }, // 09:00-17:00, doesn't cover 20:00-21:00
      rule,
      [],
      dayFrame,
      baseContext()
    )
    expect(found).toBeNull()
  })
})
