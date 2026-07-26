import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import type { ExclusionWindow } from "@/app/brain/engine/types"
import { activity } from "./support/fixtures"
import { expectPlacements } from "./support/expect-placements"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

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

describe("solve — OverlapRule (nesting, SPEC.md 14.1's spirit)", () => {
  it("nests a lower-priority guest inside its already-placed host instead of taking standalone time", () => {
    // Email's own window (09:00-09:30) sits entirely inside Work's occupied
    // span, so no top-level slot can ever satisfy it — nesting is the only
    // way it gets placed at all.
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email"] }),
      activity("Email")
        .id("email")
        .rank(2)
        .minutes(30)
        .strict("09:00", "09:30"),
    ])

    const email = result.timeline.instances.find((i) => i.name === "Email")!
    expect(email.state).toBe("PLANNED")
    expect(email.hostInstanceId).toBe("work")
    expect(email.plannedStart).toBe(540)
    expect(email.plannedEnd).toBe(570)

    // A nested guest doesn't occupy standalone top-level time: it isn't a
    // top-level instance at all (expectPlacements only looks at those).
    expectPlacements(result, { Work: "09:00-17:00" })
  })

  it("shares one budget across guests and exhausts it", () => {
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 40, guests: ["email", "call"] }),
      activity("Email")
        .id("email")
        .rank(2)
        .minutes(20)
        .strict("09:00", "09:20"),
      activity("Call").id("call").rank(3).minutes(20).strict("10:00", "10:20"),
    ])

    const email = result.timeline.instances.find((i) => i.name === "Email")!
    const call = result.timeline.instances.find((i) => i.name === "Call")!
    expect(email.hostInstanceId).toBe("work")
    expect(call.hostInstanceId).toBe("work")

    const spent = email.scheduledMinutes + call.scheduledMinutes
    expect(spent).toBe(40)
  })

  it("keeps guests from overlapping each other inside the same host", () => {
    // Both guests share the same 60-minute flexible window (zero drift, so
    // effectively pinned inside it) with room for exactly two 30-minute
    // blocks — proving the second guest's search excludes the first guest's
    // already-claimed slot rather than colliding with it.
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["a", "b"] }),
      activity("A")
        .id("a")
        .rank(2)
        .minutes(30)
        .flexible("09:00", "10:00", { drift: 0 }),
      activity("B")
        .id("b")
        .rank(3)
        .minutes(30)
        .flexible("09:00", "10:00", { drift: 0 }),
    ])
    const a = result.timeline.instances.find((i) => i.name === "A")!
    const b = result.timeline.instances.find((i) => i.name === "B")!
    expect(a.hostInstanceId).toBe("work")
    expect(b.hostInstanceId).toBe("work")
    expect(a.plannedStart).toBe(540)
    expect(a.plannedEnd).toBe(570)
    expect(b.plannedStart).toBe(570)
    expect(b.plannedEnd).toBe(600)
  })

  it("blocks nesting inside a relative exclusion window", () => {
    const focusHour: ExclusionWindow = {
      id: "focus",
      name: "Focus Hour",
      anchor: "relative",
      startOffset: 0,
      endOffset: 480, // the entire host span is excluded
    }
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email"], exclusions: [focusHour] }),
      activity("Email").id("email").rank(2).minutes(30),
    ])
    const email = result.timeline.instances.find((i) => i.name === "Email")!
    expect(email.hostInstanceId).toBeNull()
  })
})

describe("solve — OverlapRule (absolute exclusion, SPEC.md 5.7)", () => {
  it("rejects a host placement that doesn't fully contain an absolute exclusion window", () => {
    const customerCall: ExclusionWindow = {
      id: "call",
      name: "Customer Call",
      anchor: "absolute",
      startWall: "09:00",
      endWall: "10:00",
    }
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(60)
        .mandatory()
        .strict("09:15", "10:15") // never fully contains 09:00-10:00
        .overlap({ budget: 0, guests: [], exclusions: [customerCall] }),
    ])
    expectPlacements(result, { Work: "SKIPPED" })
  })

  it("places the host so the absolute exclusion window falls entirely inside it (SPEC.md 14.7's spirit)", () => {
    const customerCall: ExclusionWindow = {
      id: "call",
      name: "Customer Call",
      anchor: "absolute",
      startWall: "09:00",
      endWall: "10:00",
    }
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email"], exclusions: [customerCall] }),
      activity("Email")
        .id("email")
        .rank(2)
        .minutes(30)
        .strict("09:00", "10:00"), // exactly the excluded window — cannot nest
    ])
    expectPlacements(result, { Work: "09:00-17:00", Email: "SKIPPED" })
    const email = result.timeline.instances.find((i) => i.name === "Email")!
    expect(email.state).toBe("SKIPPED")
    expect(email.skipReason).toBe("WINDOW_UNSATISFIABLE")
  })
})
