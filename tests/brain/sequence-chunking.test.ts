import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

describe("solve — sequence dependents bind to a chunked host's first/last chunk (SPEC.md 11, edge case 12)", () => {
  it("binds the pre-dependent to the first chunk's own start and the post-dependent to the last chunk's own end", () => {
    const catalog = [
      activity("Midday Block")
        .rank(1)
        .minutes(240)
        .fixed("10:00", "14:00")
        .build(),
      activity("Evening Meeting")
        .rank(2)
        .minutes(120)
        .fixed("15:30", "17:30")
        .build(),
      activity("Deep Work")
        .rank(3)
        .minutes(120)
        .flexible("09:00", "17:30", { drift: 0 })
        .shrink({ floor: 60, chunking: true, minChunk: 45, maxChunks: 3 })
        .build(),
      activity("Commute")
        .rank(4)
        .minutes(15)
        .sequence("pre", "deep-work")
        .build(),
      activity("Cooldown")
        .rank(5)
        .minutes(15)
        .sequence("post", "deep-work")
        .build(),
    ]

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    expect(result.status).toBe("OK")
    const chunks = result.timeline.instances
      .filter((i) => i.name === "Deep Work")
      .sort((a, b) => a.blockIndex - b.blockIndex)
    expect(chunks).toHaveLength(2) // same layout as SPEC.md 14.6

    const firstChunk = chunks[0]
    const lastChunk = chunks[chunks.length - 1]

    const commute = result.timeline.instances.find((i) => i.name === "Commute")!
    expect(commute.state).toBe("PLANNED")
    expect(commute.plannedEnd).toBe(firstChunk.plannedStart) // adjacent, zero gap

    const cooldown = result.timeline.instances.find(
      (i) => i.name === "Cooldown"
    )!
    expect(cooldown.state).toBe("PLANNED")
    expect(cooldown.plannedStart).toBe(lastChunk.plannedEnd) // adjacent, zero gap
  })
})
