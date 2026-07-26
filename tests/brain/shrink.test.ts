import { describe, expect, it } from "vitest"

import { DEFAULT_COST_CONSTANTS } from "@/app/brain/engine/constants"
import type { PlacementContext } from "@/app/brain/engine/placement"
import { resolveActivity } from "@/app/brain/engine/resolve"
import { planChunks, placeWithShrinkRule } from "@/app/brain/engine/shrink"
import { resolveDayFrame } from "@/app/brain/engine/time"
import type { ShrinkRule } from "@/app/brain/engine/types"
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

describe("planChunks", () => {
  it("returns null when chunking is not allowed", () => {
    const resolved = resolveActivity(
      activity("Deep Work").rank(1).minutes(120).build(),
      dayFrame
    )
    const rule: ShrinkRule = {
      type: "shrink",
      source: "template",
      minDurationMinutes: 60,
      chunkingAllowed: false,
      minChunkMinutes: 45,
      maxChunks: 3,
    }
    expect(planChunks(resolved, rule, baseContext())).toBeNull()
  })

  it("splits across two free gaps to reach the full duration (SPEC.md 14.6)", () => {
    const resolved = resolveActivity(
      activity("Deep Work")
        .rank(1)
        .minutes(120)
        .flexible("09:00", "17:00", { drift: 0 })
        .build(),
      dayFrame
    )
    const rule: ShrinkRule = {
      type: "shrink",
      source: "template",
      minDurationMinutes: 60,
      chunkingAllowed: true,
      minChunkMinutes: 45,
      maxChunks: 3,
    }
    // Two free gaps: 09:00-10:00 (540-600) and 14:00-15:00 (840-900).
    const plan = planChunks(
      resolved,
      rule,
      baseContext({
        freeIntervals: [
          { start: 540, end: 600 },
          { start: 840, end: 900 },
        ],
      })
    )
    expect(plan).not.toBeNull()
    expect(plan!.scheduledMinutes).toBe(120)
    expect(plan!.chunks).toHaveLength(2)
    expect(
      plan!.chunks.map((c) => c.end - c.start).sort((a, b) => a - b)
    ).toEqual([60, 60])
    // One extra chunk, zero shrink, zero drift: W * CHUNK * 1.
    expect(plan!.cost).toBe(C.CHUNK)
  })

  it("returns null when the free regions cannot reach the target even chunked", () => {
    const resolved = resolveActivity(
      activity("Deep Work").rank(1).minutes(120).build(),
      dayFrame
    )
    const rule: ShrinkRule = {
      type: "shrink",
      source: "template",
      minDurationMinutes: 60,
      chunkingAllowed: true,
      minChunkMinutes: 45,
      maxChunks: 3,
    }
    const plan = planChunks(
      resolved,
      rule,
      baseContext({ freeIntervals: [{ start: 0, end: 50 }] })
    )
    expect(plan).toBeNull()
  })
})

describe("placeWithShrinkRule", () => {
  it("prefers chunking over a single shrunk block when it is cheaper (SPEC.md 14.6)", () => {
    const resolved = resolveActivity(
      activity("Deep Work")
        .rank(1)
        .minutes(120)
        .flexible("09:00", "17:00", { drift: 0 })
        .build(),
      dayFrame
    )
    const rule: ShrinkRule = {
      type: "shrink",
      source: "template",
      minDurationMinutes: 60,
      chunkingAllowed: true,
      minChunkMinutes: 45,
      maxChunks: 3,
    }
    const outcome = placeWithShrinkRule(
      resolved,
      rule,
      baseContext({
        freeIntervals: [
          { start: 540, end: 600 },
          { start: 840, end: 900 },
        ],
      })
    )
    expect(outcome.placement).toBeNull()
    expect(outcome.chunks).toHaveLength(2)
    expect(outcome.scheduledMinutes).toBe(120)
  })

  it("falls back to a single block when chunking is not allowed", () => {
    const resolved = resolveActivity(
      activity("Gym").rank(1).minutes(60).build(),
      dayFrame
    )
    const rule: ShrinkRule = {
      type: "shrink",
      source: "template",
      minDurationMinutes: 30,
      chunkingAllowed: false,
      minChunkMinutes: 30,
      maxChunks: 3,
    }
    const outcome = placeWithShrinkRule(resolved, rule, baseContext())
    expect(outcome.chunks).toBeNull()
    expect(outcome.placement).toEqual({ start: 0, end: 60, nestedIn: null })
  })

  it("behaves like an unshrinkable activity when there is no ShrinkRule", () => {
    const resolved = resolveActivity(
      activity("Gym").rank(1).minutes(60).build(),
      dayFrame
    )
    const outcome = placeWithShrinkRule(
      resolved,
      null,
      baseContext({ freeIntervals: [{ start: 0, end: 30 }] })
    )
    expect(outcome.placement).toBeNull()
    expect(outcome.chunks).toBeNull()
    expect(outcome.skipReason).toBe("NO_FREE_SPACE")
  })
})
