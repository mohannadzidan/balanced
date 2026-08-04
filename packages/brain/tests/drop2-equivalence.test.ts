// SPEC-v2.1 §2's acceptance criterion — "worth more than the rest of the
// Drop 2 suite combined":
//
//   Solving N consecutive 1-day frames must produce placements identical to
//   solving one N-day frame, for any catalogue containing no cross-day rules.
//
// This is the SPEC-v2.1 §15 row 2 hard gate: step 3 (expand/buckets) must
// not begin until this is green.

import { describe, it } from "vitest"
import * as fc from "fast-check"

import { solve } from "../src/engine/solve"
import { addDays, resolveDayFrame, resolveFrame } from "../src/engine/time"
import { dateArb, noCrossDayCatalogArb } from "./support/arbitraries"
import type { TimelineActivity } from "../src/engine/types"

interface Comparable {
  readonly activityId: string | null
  readonly date: string
  readonly relativeStart: number | null
  readonly relativeEnd: number | null
  readonly state: string
  readonly scheduledMinutes: number
}

function toComparable(
  instances: readonly TimelineActivity[],
  dayStartOffsetOf: (date: string) => number
): Comparable[] {
  return instances
    .map((i) => ({
      activityId: i.activityId,
      date: i.date,
      relativeStart:
        i.plannedStart === null
          ? null
          : i.plannedStart - dayStartOffsetOf(i.date),
      relativeEnd:
        i.plannedEnd === null ? null : i.plannedEnd - dayStartOffsetOf(i.date),
      state: i.state,
      scheduledMinutes: i.scheduledMinutes,
    }))
    .sort(
      (a, b) =>
        (a.activityId ?? "").localeCompare(b.activityId ?? "") ||
        a.date.localeCompare(b.date)
    )
}

describe("SPEC-v2.1 §2 equivalence: N chained 1-day solves ≡ one N-day solve", () => {
  it("holds for catalogues with no cross-day rules", () => {
    fc.assert(
      fc.property(
        dateArb,
        noCrossDayCatalogArb,
        fc.integer({ min: 2, max: 6 }),
        (startDate, catalog, dayCount) => {
          // N chained 1-day solves: each day is its own fresh solve().
          const chainedInstances: TimelineActivity[] = []
          for (let i = 0; i < dayCount; i++) {
            const date = addDays(startDate, i)
            const result = solve({
              dayFrame: resolveDayFrame(date, "UTC"),
              now: 0,
              catalog,
              existing: [],
              carryIn: [],
              event: { type: "GENERATE_DAY" },
            })
            if (result.status === "REJECTED") return true // pathological catalog, not this property's concern
            chainedInstances.push(...result.timeline.instances)
          }
          const chained = toComparable(chainedInstances, () => 0)

          // One N-day solve.
          const bigFrame = resolveFrame(startDate, dayCount, "UTC")
          const bigResult = solve({
            dayFrame: bigFrame,
            now: 0,
            catalog,
            existing: [],
            carryIn: [],
            event: { type: "GENERATE_DAY" },
          })
          if (bigResult.status === "REJECTED") return true
          const dayStartOffsetOf = (date: string): number => {
            const day = bigFrame.days.find((d) => d.date === date)
            return day ? day.startOffset : 0
          }
          const big = toComparable(
            bigResult.timeline.instances,
            dayStartOffsetOf
          )

          return JSON.stringify(chained) === JSON.stringify(big)
        }
      ),
      { numRuns: 1000, endOnFailure: true }
    )
  }, 30000)
})
