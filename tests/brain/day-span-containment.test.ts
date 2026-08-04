// SPEC-v2.1 §4.1's second feasibility conjunct: "candidate ⊆ union of
// eligible day spans". Drift softens a window; it must never soften day
// eligibility — a generous maxDriftMinutes must not let a candidate bleed
// off an eligible day onto one the activity was never eligible for at all.

import { describe, expect, it } from "vitest"
import {
  evaluateCandidate,
  resolveActivity,
  resolveWindows,
} from "@/app/brain/engine/resolve"
import type { ResolvedActivity } from "@/app/brain/engine/resolve"
import { resolveFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

describe("evaluateCandidate: day-span containment (SPEC-v2.1 §4.1)", () => {
  it("rejects a candidate on a day the activity has no window on, even with unlimited drift", () => {
    const frame = resolveFrame("2026-07-27", 3, "UTC") // Mon, Tue, Wed
    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .window("09:00", "10:00", { drift: 1000, days: ["TUE"] })
      .build()
    const resolved: ResolvedActivity = {
      activity: gym,
      windows: resolveWindows(gym, frame),
    }

    // Entirely inside Tuesday's window: feasible.
    const tueDay = frame.days[1]
    const onWindow = evaluateCandidate(
      resolved,
      tueDay.startOffset + 9 * 60,
      tueDay.startOffset + 10 * 60
    )
    expect(onWindow.feasible).toBe(true)

    // Same clock time, but on Wednesday — a day with no window at all. Raw
    // drift (60 minutes) is well within the 1000-minute allowance, so a
    // drift-only check would wrongly call this feasible.
    const wedDay = frame.days[2]
    const onWrongDay = evaluateCandidate(
      resolved,
      wedDay.startOffset + 9 * 60,
      wedDay.startOffset + 10 * 60
    )
    expect(onWrongDay.feasible).toBe(false)
  })

  it("permits drift within the eligible day's own span", () => {
    const frame = resolveFrame("2026-07-27", 3, "UTC")
    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .window("09:00", "10:00", { drift: 180, days: ["TUE"] })
      .build()
    const resolved: ResolvedActivity = {
      activity: gym,
      windows: resolveWindows(gym, frame),
    }

    const tueDay = frame.days[1]
    // Drifted 2 hours early, still on Tuesday, still within the 3h allowance.
    const drifted = evaluateCandidate(
      resolved,
      tueDay.startOffset + 7 * 60,
      tueDay.startOffset + 8 * 60
    )
    expect(drifted.feasible).toBe(true)
    expect(drifted.driftMinutes).toBe(60)
  })

  it("a spanning window's eligible span extends into the next day", () => {
    const frame = resolveFrame("2026-07-27", 3, "UTC") // Mon, Tue, Wed
    const sleep = activity("Sleep")
      .rank(1)
      .minutes(480)
      .window("23:00", "07:00", { drift: 0, days: ["MON"] })
      .build()
    const resolved: ResolvedActivity = {
      activity: sleep,
      windows: resolveWindows(sleep, frame),
    }

    // Placed exactly at the window: 23:00 Mon to 07:00 Tue.
    const start = frame.days[0].startOffset + 23 * 60
    const end = frame.days[0].startOffset + 24 * 60 + 7 * 60
    expect(evaluateCandidate(resolved, start, end).feasible).toBe(true)
  })

  it("resolveActivity's degenerate single-day form also gets a containment span", () => {
    const frame = resolveFrame("2026-07-27", 1, "UTC")
    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .window("09:00", "10:00", { drift: 1000 })
      .build()
    const resolved = resolveActivity(gym, frame)

    expect(evaluateCandidate(resolved, 9 * 60, 10 * 60).feasible).toBe(true)
    // Nothing beyond the single day exists to test against here, but the
    // day span itself must be finite (not unbounded), or this containment
    // check would be a no-op for every resolveActivity caller.
    expect(resolved.windows[0].daySpanStart).toBe(0)
    expect(resolved.windows[0].daySpanEnd).toBe(frame.days[0].lengthMinutes)
  })
})
