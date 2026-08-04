import { describe, it, expect } from "vitest"

import { activityProgressMin } from "../../lib/domain/accounting"
import type { ScheduledBlock } from "../../lib/domain/types"

function block(
  activityId: string,
  startMin: number,
  endMin: number,
  hostActivityId: string | null = null
): ScheduledBlock {
  return {
    id: `${activityId}-${startMin}`,
    activityId,
    date: "2026-07-25",
    startMin,
    endMin,
    hostActivityId,
  }
}

describe("activityProgressMin", () => {
  it("is zero when the activity has no blocks", () => {
    expect(activityProgressMin("freelance", [])).toBe(0)
  })

  it("is zero when only other activities have blocks", () => {
    const blocks = [block("lunch", 780, 810)]
    expect(activityProgressMin("freelance", blocks)).toBe(0)
  })

  it("sums the activity's own block durations", () => {
    const blocks = [
      block("freelance", 1140, 1260),
      block("freelance", 480, 540),
    ]
    expect(activityProgressMin("freelance", blocks)).toBe(180)
  })

  it("returns over-target totals uncapped (Edge Case)", () => {
    const blocks = [
      block("freelance", 0, 300),
      block("freelance", 300, 600),
      block("freelance", 600, 900),
    ]
    // Well past a 4h (240m) target — reported as-is, never capped.
    expect(activityProgressMin("freelance", blocks)).toBe(900)
  })

  it("counts a guest block toward the guest's own progress, not the host's", () => {
    const blocks = [block("lunch", 780, 810, "fulltime-work")]
    expect(activityProgressMin("lunch", blocks)).toBe(30)
    expect(activityProgressMin("fulltime-work", blocks)).toBe(0)
  })
})
