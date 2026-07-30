// SPEC-v2.1 §7.4 done-when: "Absolute exclusion windows resolve per day;
// an absolute exclusion constrains only the host occurrence in whose
// bucket it falls." Without this scoping, a recurring host with one
// absolute exclusion is unsatisfiable the moment there is more than one
// of them.
//
// Unit-tested at the resolveAbsoluteExclusions boundary — the function
// reads frame.days[dayIndex] for the host occurrence's bucket, rather
// than always resolving against day 0. The host-recurrence wiring that
// turns this into a 7-day success is downstream; lifting `isGhostable`'s
// "OverlapRule → single instance" guard for recurrence hosts is the
// companion change that §7.4 calls out as the v1→Drop 2 behavior
// difference, and lands separately (§15 row 7.4 work; deferred until a
// spec/UX driver motivates it).

import { describe, expect, it } from "vitest"

import { resolveAbsoluteExclusions } from "@/app/brain/engine/overlap"
import { resolveFrame } from "@/app/brain/engine/time"
import type { OverlapRule } from "@/app/brain/engine/types"

describe("SPEC-v2.1 §7.4: per-day absolute exclusions", () => {
  it("resolves the same absolute window against different dayIndex values", () => {
    const frame = resolveFrame("2026-07-27", 7, "UTC")
    const rule: OverlapRule = {
      type: "overlap",
      source: "template",
      budgetMinutes: 60,
      allowedGuestIds: [],
      exclusionWindows: [
        { id: "lunch", name: "Lunch", anchor: "absolute", startWall: "12:00", endWall: "13:00" },
      ],
    }

    const day0 = resolveAbsoluteExclusions(rule, frame, 0)
    const day3 = resolveAbsoluteExclusions(rule, frame, 3)

    expect(day0).toEqual([{ start: 12 * 60, end: 13 * 60 }])
    expect(day3).toEqual([{ start: 3 * 1440 + 12 * 60, end: 3 * 1440 + 13 * 60 }])
  })

  it("default dayIndex=0 reproduces the v1 once-per-frame resolution", () => {
    const frame = resolveFrame("2026-07-27", 7, "UTC")
    const rule: OverlapRule = {
      type: "overlap",
      source: "template",
      budgetMinutes: 60,
      allowedGuestIds: [],
      exclusionWindows: [
        { id: "lunch", name: "Lunch", anchor: "absolute", startWall: "12:00", endWall: "13:00" },
      ],
    }

    const explicit = resolveAbsoluteExclusions(rule, frame, 0)
    const defaulted = resolveAbsoluteExclusions(rule, frame)
    expect(defaulted).toEqual(explicit)
    expect(defaulted).toEqual([{ start: 12 * 60, end: 13 * 60 }])
  })

  it("returns an empty list when the activity has no OverlapRule", () => {
    const frame = resolveFrame("2026-07-27", 1, "UTC")
    expect(resolveAbsoluteExclusions(null, frame, 0)).toEqual([])
    expect(resolveAbsoluteExclusions(null, frame, 3)).toEqual([])
  })
})
