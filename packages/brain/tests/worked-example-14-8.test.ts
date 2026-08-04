import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "./support/solve-checked"
import { resolveDayFrame, weekdayOf } from "../src/engine/time"
import { activity } from "./support/fixtures"

/**
 * SPEC.md 14.8: Night Shift is fixed 22:00-06:00, so it spans midnight from
 * day A into day B. Each variant places the actual DST transition inside
 * the shift's own overnight window (rather than earlier in day A, where it
 * wouldn't affect this arithmetic at all) so the overflow figure below can
 * only be right if the engine resolves "06:00" against day B's own DST
 * situation instead of assuming a plain 360-minute (6-hour) tail.
 */
const variants = [
  {
    label: "1440-minute days, no DST",
    dayA: "2024-06-17",
    dayB: "2024-06-18",
    timezone: "UTC",
    overflow: 360, // a plain 6 hours
  },
  {
    label: "spring-forward inside the shift (day B is the 1380-minute day)",
    dayA: "2024-03-09",
    dayB: "2024-03-10",
    timezone: "America/New_York",
    overflow: 300, // 6h minus the skipped hour
  },
  {
    label: "fall-back inside the shift (day B is the 1500-minute day)",
    dayA: "2024-11-02",
    dayB: "2024-11-03",
    timezone: "America/New_York",
    overflow: 420, // 6h plus the repeated hour
  },
]

describe("solve — SPEC.md 14.8: midnight span and carry-in", () => {
  for (const v of variants) {
    it(`places Night Shift to the day boundary, carries the overflow, and supports finishing it early — ${v.label}`, () => {
      const dayFrameA = resolveDayFrame(v.dayA, v.timezone)
      const dayFrameB = resolveDayFrame(v.dayB, v.timezone)
      // Scoped to day A's own weekday only, so this single occurrence can't
      // also try to regenerate fresh on day B — recurring midnight-spanning
      // activities are multi-day lookahead, out of scope (SPEC.md Section 15).
      const catalog = [
        activity("Night Shift")
          .rank(1)
          .minutes(480)
          .fixed("22:00", "06:00")
          .days(weekdayOf(v.dayA))
          .build(),
      ]

      const dayA = solve({
        dayFrame: dayFrameA,
        now: 0,
        catalog,
        existing: [],
        carryIn: [],
        event: { type: "GENERATE_DAY" },
      })
      const shiftA = dayA.timeline.instances.find(
        (i) => i.name === "Night Shift"
      )!
      expect(shiftA.plannedStart).toBe(1320) // 22:00, unaffected by day B's DST

      const finalisedA = solve({
        dayFrame: dayFrameA,
        now: dayFrameA.lengthMinutes,
        catalog,
        existing: dayA.timeline.instances,
        carryIn: [],
        event: { type: "FINALISE_FRAME" },
        revision: dayA.timeline.revision,
      })
      expect(finalisedA.status).not.toBe("REJECTED")

      // "Day A holds 22:00-24:00" — placed to the day boundary.
      const shiftAFinal = finalisedA.timeline.instances.find(
        (i) => i.name === "Night Shift"
      )!
      expect(shiftAFinal.plannedStart).toBe(1320)
      expect(shiftAFinal.plannedEnd).toBe(dayFrameA.lengthMinutes)
      expect(shiftAFinal.scheduledMinutes).toBe(dayFrameA.lengthMinutes - 1320)

      const carriedShift = finalisedA.timeline.carryIn.find(
        (i) => i.name === "Night Shift"
      )
      expect(carriedShift).toBeDefined()
      expect(carriedShift?.state).toBe("CARRIED_IN")
      expect(carriedShift?.spanningFromPreviousDay).toBe(true)
      expect(carriedShift?.plannedStart).toBe(0)
      expect(carriedShift?.plannedEnd).toBe(v.overflow)
      expect(carriedShift?.scheduledMinutes).toBe(v.overflow)

      // "Day B opens with a locked CARRIED_IN block 00:00-06:00."
      const dayBCatalog = [
        ...catalog,
        activity("Coffee").rank(2).minutes(30).build(),
      ]
      const dayB = solve({
        dayFrame: dayFrameB,
        now: 0,
        catalog: dayBCatalog,
        existing: [],
        carryIn: finalisedA.timeline.carryIn,
        event: { type: "GENERATE_DAY" },
      })
      const shiftB = dayB.timeline.instances.find(
        (i) => i.name === "Night Shift"
      )!
      expect(shiftB.state).toBe("CARRIED_IN")
      expect(shiftB.plannedStart).toBe(0)
      expect(shiftB.plannedEnd).toBe(v.overflow)
      expect(shiftB.locked).toBeFalsy()

      const coffeeBefore = dayB.timeline.instances.find(
        (i) => i.name === "Coffee"
      )!
      // Nothing may be scheduled before the carry-in block ends.
      expect(coffeeBefore.plannedStart).toBe(v.overflow)

      // "Finishing it early at 04:00 frees 04:00-06:00 and re-solves day B
      // from that point."
      const finishedEarly = solve({
        dayFrame: dayFrameB,
        now: 0,
        catalog: dayBCatalog,
        existing: dayB.timeline.instances,
        carryIn: [],
        event: { type: "FINISH_EARLY", instanceId: shiftB.id, at: 240 },
        revision: dayB.timeline.revision,
      })
      expect(finishedEarly.status).not.toBe("REJECTED")

      const shiftBFinished = finishedEarly.timeline.instances.find(
        (i) => i.name === "Night Shift"
      )!
      expect(shiftBFinished.state).toBe("COMPLETED")
      expect(shiftBFinished.completedSource).toBe("user")
      expect(shiftBFinished.actualStart).toBe(0)
      expect(shiftBFinished.actualEnd).toBe(240)

      const coffeeAfter = finishedEarly.timeline.instances.find(
        (i) => i.name === "Coffee"
      )!
      expect(coffeeAfter.plannedStart).toBe(240)
    })
  }
})
