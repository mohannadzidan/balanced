// SPEC-v2.1 §8.1 / §15 row 6 done-when: "A block spanning a frame boundary
// survives as one instance across two solves." `prelude` is the channel
// that lets a prior frame's overflow become this frame's occupied interval
// without duplicating the instance.

import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/brain"
import { resolveFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

describe("SPEC-v2.1 §8.1: prelude carries a spanning block across two solves", () => {
  it("a block that overflows frame 1 by 30 minutes occupies the first 30 minutes of frame 2 via prelude", () => {
    const frame1 = resolveFrame("2026-07-27", 1, "UTC")
    const frame2 = resolveFrame("2026-07-28", 1, "UTC")

    // A fixed 23:00–01:00 night shift — a strict FixedRule that spans
    // midnight. With a 1-day frame, the block is placed 23:00–01:00 of the
    // same calendar date, which means `plannedEnd` lands 60 minutes past
    // `lengthMinutes` (1440).
    const nightShift = activity("Night Shift")
      .rank(1)
      .minutes(60)
      .fixed("23:00", "01:00")
      .build()

    // Frame 1 GENERATE_DAY.
    const r1 = solve({
      dayFrame: frame1,
      now: 0,
      catalog: [nightShift],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    expect(r1.status).not.toBe("REJECTED")
    const placed = r1.timeline.instances.find((i) => i.name === "Night Shift")!
    expect(placed.plannedStart).not.toBeNull()
    expect(placed.plannedEnd).not.toBeNull()

    // The block overflows frame 1 — its plannedEnd is past lengthMinutes.
    expect(placed.plannedEnd!).toBeGreaterThan(frame1.lengthMinutes)

    // Build the prelude entry as §8.1 describes: same instance, expressed
    // in this frame's coordinates. The overflow `past lengthMinutes` becomes
    // the prelude entry's `[end - lengthMinutes]` end. Negative starts are
    // allowed and stay negative — the solver clips to 0 internally.
    const overflowStart = (placed.plannedStart ?? 0) - frame1.lengthMinutes
    const overflowEnd = (placed.plannedEnd ?? 0) - frame1.lengthMinutes
    expect(overflowStart).toBeLessThan(0)
    expect(overflowEnd).toBeGreaterThan(0)

    const preludeEntry = {
      ...placed,
      plannedStart: overflowStart,
      plannedEnd: overflowEnd,
      scheduledMinutes: overflowEnd - overflowStart,
    }

    // Frame 2: a GENERATE_DAY with the prelude carries the overflow as
    // occupied. A 30-minute follow-up activity with a window that includes
    // 00:00–01:00 will have its earliest feasible start bumped past the
    // prelude's [0, 30) — proving the prelude is acting as occupied.
    const followUp = activity("Follow Up")
      .rank(1)
      .minutes(30)
      .window("00:00", "03:00")
      .build()

    const r2 = solve({
      dayFrame: frame2,
      now: 0,
      catalog: [followUp],
      existing: [],
      carryIn: [],
      prelude: [preludeEntry],
      event: { type: "GENERATE_DAY" },
    })
    expect(r2.status).not.toBe("REJECTED")

    const placedFollowUp = r2.timeline.instances.find(
      (i) => i.name === "Follow Up"
    )!
    expect(placedFollowUp.state).toBe("PLANNED")
    expect(placedFollowUp.plannedStart!).toBeGreaterThanOrEqual(30)
  })
})
