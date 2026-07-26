import { describe, expect, it } from "vitest"

import { DEFAULT_COST_CONSTANTS } from "@/app/brain/engine/constants"
import {
  placeFixedSet,
  placeHardSet,
  resolveFixedPlacement,
} from "@/app/brain/engine/hard-set"
import { resolveActivity } from "@/app/brain/engine/resolve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import type { Activity, FixedRule } from "@/app/brain/engine/types"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")
const resolve = (a: Activity) => resolveActivity(a, dayFrame)
const weight = () => 1

describe("resolveFixedPlacement", () => {
  it("resolves an ordinary same-day window", () => {
    const rule: FixedRule = {
      type: "fixed",
      source: "template",
      startWall: "09:00",
      endWall: "10:00",
    }
    expect(resolveFixedPlacement(rule, dayFrame)).toEqual({
      start: 540,
      end: 600,
      nestedIn: null,
    })
  })

  it("spans midnight when the end is not after the start", () => {
    const rule: FixedRule = {
      type: "fixed",
      source: "template",
      startWall: "22:00",
      endWall: "06:00",
    }
    expect(resolveFixedPlacement(rule, dayFrame)).toEqual({
      start: 1320,
      end: 1440 + 360,
      nestedIn: null,
    })
  })
})

describe("placeFixedSet", () => {
  it("places non-overlapping fixed activities at their declared times", () => {
    const activities = [
      activity("Sleep").rank(1).minutes(60).fixed("22:00", "23:00").build(),
      activity("Standup").rank(2).minutes(15).fixed("09:00", "09:15").build(),
    ]
    const result = placeFixedSet(activities, dayFrame, 0)
    expect(result.placements.get("sleep")).toEqual({
      start: 1320,
      end: 1380,
      nestedIn: null,
    })
    expect(result.placements.get("standup")).toEqual({
      start: 540,
      end: 555,
      nestedIn: null,
    })
    expect(result.diagnostics).toEqual([])
  })

  it("marks both activities infeasible when two fixed windows overlap", () => {
    const activities = [
      activity("A").rank(1).minutes(60).fixed("09:00", "10:00").build(),
      activity("B").rank(2).minutes(60).fixed("09:30", "10:30").build(),
    ]
    const result = placeFixedSet(activities, dayFrame, 0)
    expect(result.placements.size).toBe(0)
    expect(result.skipped.get("a")).toBe("INFEASIBLE_HARD_CONSTRAINT")
    expect(result.skipped.get("b")).toBe("INFEASIBLE_HARD_CONSTRAINT")
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].code).toBe("FIXED_COLLISION")
    expect(result.diagnostics[0].severity).toBe("blocking")
  })

  it("marks a fixed activity infeasible if it starts before the freeze boundary", () => {
    const activities = [
      activity("Early").rank(1).minutes(60).fixed("00:00", "01:00").build(),
    ]
    const result = placeFixedSet(activities, dayFrame, 120)
    expect(result.skipped.get("early")).toBe("INFEASIBLE_HARD_CONSTRAINT")
  })
})

describe("placeHardSet", () => {
  const ctx = {
    freezeBoundary: 0,
    grid: 5,
    lengthMinutes: 1440,
    nodeLimit: 5000,
    constants: DEFAULT_COST_CONSTANTS,
    resolve,
    weight,
  }

  it("places a single mandatory activity in the first available slot", () => {
    const items = [activity("Gym").rank(1).minutes(60).mandatory().build()]
    const result = placeHardSet(items, [], ctx)
    expect(result.placements.get("gym")).toEqual({
      start: 0,
      end: 60,
      nestedIn: null,
    })
    expect(result.skipped.size).toBe(0)
  })

  it("orders most-constrained-first so both mandatory activities fit", () => {
    // Free space: [0, 100) and [200, 250). A needs 90m (only fits in the
    // first gap); B needs 40m (fits in either). Placing A first — because
    // it has fewer feasible starts — leaves room for B.
    const baseOccupied = [
      { start: 100, end: 200 },
      { start: 250, end: 1440 },
    ]
    const items = [
      activity("B").rank(1).minutes(40).mandatory().build(),
      activity("A").rank(2).minutes(90).mandatory().build(),
    ]
    const result = placeHardSet(items, baseOccupied, ctx)
    expect(result.skipped.size).toBe(0)
    expect(result.placements.get("a")).toEqual({
      start: 0,
      end: 90,
      nestedIn: null,
    })
    expect(result.placements.get("b")?.start).toBeGreaterThanOrEqual(90)
  })

  it("skips a mandatory activity that cannot fit anywhere", () => {
    const items = [activity("Huge").rank(1).minutes(2000).mandatory().build()]
    const result = placeHardSet(items, [], ctx)
    expect(result.skipped.get("huge")).toBe("INFEASIBLE_HARD_CONSTRAINT")
  })

  it("backtracks when the greedy choice for one activity blocks another", () => {
    // A single 100m free interval. Two mandatory activities of 60m each
    // cannot both fit — one must be reported infeasible, not silently
    // dropped or duplicated.
    const items = [
      activity("A").rank(1).minutes(60).mandatory().build(),
      activity("B").rank(2).minutes(60).mandatory().build(),
    ]
    const result = placeHardSet(items, [{ start: 100, end: 1440 }], {
      ...ctx,
      lengthMinutes: 200,
    })
    const placedCount = result.placements.size
    const skippedCount = result.skipped.size
    expect(placedCount).toBe(1)
    expect(skippedCount).toBe(1)
  })
})
