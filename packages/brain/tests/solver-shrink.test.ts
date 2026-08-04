import { describe, expect, it } from "vitest"

import { DEFAULT_COST_CONSTANTS } from "../src/engine/constants"
import { priorityWeight } from "../src/engine/cost"
import { solveChecked as solve } from "./support/solve-checked"
import { resolveDayFrame } from "../src/engine/time"
import { activity } from "./support/fixtures"
import { expectPlacements } from "./support/expect-placements"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")
const C = DEFAULT_COST_CONSTANTS

function generate(catalog: ReturnType<typeof activity>[]) {
  return solve({
    dayFrame,
    now: 0,
    catalog: catalog.map((b) => b.build()),
    existing: [],
    carryIn: [],
    event: { type: "GENERATE_DAY" },
  })
}

describe("solve — ShrinkRule (single block)", () => {
  it("shrinks to the floor when the full duration cannot fit (SPEC.md 14.2's spirit)", () => {
    // Gym: mandatory, flexible 18:00-20:00 drift 0, shrink floor 45, 60m
    // full duration. Work and Dinner (both fixed) leave two sub-gaps inside
    // the window — 18:00-18:45 (45m) and 19:30-20:00 (30m) — neither fits
    // the full 60m and zero drift is allowed, so only the 45m floor, in the
    // larger of the two gaps, is feasible.
    const result = generate([
      activity("Work").rank(1).minutes(540).fixed("09:00", "18:00"),
      activity("Dinner").rank(2).minutes(45).fixed("18:45", "19:30"),
      activity("Gym")
        .rank(3)
        .minutes(60)
        .mandatory()
        .flexible("18:00", "20:00", { drift: 0 })
        .shrink({ floor: 45 }),
    ])
    expectPlacements(result, {
      Work: "09:00-18:00",
      Dinner: "18:45-19:30",
      Gym: "18:00-18:45",
    })
    const gym = result.timeline.instances.find((i) => i.name === "Gym")!
    expect(gym.scheduledMinutes).toBe(45)
    expect(gym.relaxations).toEqual([{ type: "shrink", minutes: 15 }])
    expect(result.status).toBe("OK")

    const diag = result.diagnostics.find((d) => d.code === "SHRUNK")
    expect(diag?.message).toBe('"Gym" shortened from 60 to 45 minutes.')
  })

  it("prefers full duration (zero cost) over shrinking when both fit", () => {
    const result = generate([
      activity("Gym").rank(1).minutes(60).shrink({ floor: 30 }),
    ])
    expectPlacements(result, { Gym: "00:00-01:00" })
    const gym = result.timeline.instances.find((i) => i.name === "Gym")!
    expect(gym.relaxations).toEqual([])
  })

  it("skips (does not shrink below the floor) when even the floor cannot fit", () => {
    const result = generate([
      activity("Gym")
        .rank(1)
        .minutes(60)
        .strict("09:00", "09:20")
        .shrink({ floor: 45 }),
    ])
    expectPlacements(result, { Gym: "SKIPPED" })
  })

  it("shrink cost matches the SHRINK constant", () => {
    const result = generate([
      activity("Gym")
        .rank(1)
        .minutes(60)
        .strict("09:00", "09:45")
        .shrink({ floor: 30 }),
    ])
    expectPlacements(result, { Gym: "09:00-09:45" })
    const weight = priorityWeight(1, 1)
    expect(result.cost.shrink).toBe(weight * C.SHRINK * 15)
  })

  it("shrinks a mandatory activity placed via the hard-set backtracking path", () => {
    const result = generate([
      activity("Meeting").rank(1).minutes(60).fixed("09:00", "10:00"),
      activity("Focus")
        .rank(2)
        .minutes(90)
        .mandatory()
        .strict("08:00", "10:00")
        .shrink({ floor: 30 }),
    ])
    expectPlacements(result, {
      Meeting: "09:00-10:00",
      Focus: "08:00-09:00",
    })
    const focus = result.timeline.instances.find((i) => i.name === "Focus")!
    expect(focus.scheduledMinutes).toBe(60)
  })
})

describe("solve — ShrinkRule (chunking, SPEC.md 14.6)", () => {
  it("chunks into two blocks across the day's two free gaps", () => {
    // Deep Work: flexible 09:00-17:00 drift 0, shrink floor 60, chunking
    // allowed (min 45, max 3), 120m full duration. Two fixed meetings carve
    // the window down to exactly two 60-minute gaps: 09:00-10:00 and
    // 14:00-15:00. Chunking into those two gaps (cost: one extra chunk)
    // beats both skipping and shrinking to a single 60-minute block.
    const result = generate([
      activity("Meeting A").rank(1).minutes(240).fixed("10:00", "14:00"),
      activity("Meeting B").rank(2).minutes(120).fixed("15:00", "17:00"),
      activity("Deep Work")
        .rank(3)
        .minutes(120)
        .flexible("09:00", "17:00", { drift: 0 })
        .shrink({ floor: 60, chunking: true, minChunk: 45, maxChunks: 3 }),
    ])

    const chunks = result.timeline.instances
      .filter((i) => i.name === "Deep Work")
      .sort((a, b) => (a.plannedStart ?? 0) - (b.plannedStart ?? 0))

    expect(chunks).toHaveLength(2)
    expect(chunks[0].plannedStart).toBe(540) // 09:00
    expect(chunks[0].plannedEnd).toBe(600) // 10:00
    expect(chunks[1].plannedStart).toBe(840) // 14:00
    expect(chunks[1].plannedEnd).toBe(900) // 15:00

    expect(chunks[0].chunkGroupId).toBe(chunks[1].chunkGroupId)
    expect(chunks[0].blockIndex).toBe(1)
    expect(chunks[1].blockIndex).toBe(2)
    expect(chunks[0].blockCount).toBe(2)
    expect(chunks[1].blockCount).toBe(2)
    expect(chunks[0].relaxations).toEqual([{ type: "chunk", minutes: 1 }])
    expect(chunks[1].relaxations).toEqual([])

    const weight = priorityWeight(3, 3)
    expect(result.cost.chunk).toBe(weight * C.CHUNK)
    expect(result.cost.shrink).toBe(0)
    expect(result.cost.drift).toBe(0)

    const diag = result.diagnostics.find((d) => d.code === "CHUNKED")
    expect(diag?.message).toBe('"Deep Work" was split into 2 blocks.')
  })

  it("partially completes a chunked activity when the day can't fit its full duration, instead of skipping it outright (SPEC.md 14.6b / edge case 23)", () => {
    // Deep Work: 120m, window 09:00-14:00 drift 0, shrink floor 90,
    // chunking allowed (min 45, max 3). Meeting A and Meeting B carve the
    // window down to exactly two 50-minute gaps (09:00-09:50, 13:00-13:50)
    // — 100 minutes total, short of the full 120 but past the 90-minute
    // floor, and no single contiguous span reaches 90 at all.
    const result = generate([
      activity("Meeting A").rank(1).minutes(190).fixed("09:50", "13:00"),
      activity("Meeting B").rank(2).minutes(250).fixed("13:50", "18:00"),
      activity("Deep Work")
        .rank(3)
        .minutes(120)
        .flexible("09:00", "14:00", { drift: 0 })
        .shrink({ floor: 90, chunking: true, minChunk: 45, maxChunks: 3 }),
    ])

    const chunks = result.timeline.instances
      .filter((i) => i.name === "Deep Work")
      .sort((a, b) => (a.plannedStart ?? 0) - (b.plannedStart ?? 0))

    expect(chunks).toHaveLength(2)
    expect(chunks.every((c) => c.state === "PLANNED")).toBe(true)
    expect(chunks[0].plannedStart).toBe(540) // 09:00
    expect(chunks[0].plannedEnd).toBe(590) // 09:50
    expect(chunks[1].plannedStart).toBe(780) // 13:00
    expect(chunks[1].plannedEnd).toBe(830) // 13:50

    const totalScheduled = chunks.reduce((s, c) => s + c.scheduledMinutes, 0)
    expect(totalScheduled).toBe(100)
    // Recorded once, on the first chunk: shrunk by 20 (120 -> 100) and one
    // extra chunk, same as any other relaxed chunk plan.
    expect(chunks[0].relaxations).toEqual(
      expect.arrayContaining([
        { type: "shrink", minutes: 20 },
        { type: "chunk", minutes: 1 },
      ])
    )
  })
})
