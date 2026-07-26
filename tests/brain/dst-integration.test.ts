import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

describe("solve — DST day lengths flow through the whole pipeline (SPEC.md 11, cases 4-5)", () => {
  it("shrinks the mandatory day-filling activity on the 1380-minute spring-forward day, not a bug", () => {
    const dayFrame = resolveDayFrame("2024-03-10", "America/New_York")
    expect(dayFrame.lengthMinutes).toBe(1380)

    // Sized to exactly fill a normal 1440-minute day — on this shorter day
    // it can't, so it must shrink (or skip) rather than overflow the frame.
    const catalog = [
      activity("All Day")
        .rank(1)
        .minutes(1440)
        .mandatory()
        .shrink({ floor: 1380 })
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
    const allDay = result.timeline.instances[0]
    expect(allDay.plannedStart).toBe(0)
    expect(allDay.plannedEnd).toBe(1380)
    expect(allDay.scheduledMinutes).toBe(1380)
  })

  it("degrades (not crashes) when a mandatory day-filler has no shrink room on the short day", () => {
    const dayFrame = resolveDayFrame("2024-03-10", "America/New_York")
    const catalog = [
      activity("All Day").rank(1).minutes(1440).mandatory().build(),
    ]

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    expect(result.status).toBe("DEGRADED")
    const allDay = result.timeline.instances[0]
    expect(allDay.state).toBe("SKIPPED")
  })

  it("comfortably fits the same day-filling activity on the 1500-minute fall-back day", () => {
    const dayFrame = resolveDayFrame("2024-11-03", "America/New_York")
    expect(dayFrame.lengthMinutes).toBe(1500)

    const catalog = [
      activity("All Day").rank(1).minutes(1440).mandatory().build(),
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
    const allDay = result.timeline.instances[0]
    expect(allDay.state).toBe("PLANNED")
    expect(allDay.plannedStart).toBe(0)
    expect(allDay.plannedEnd).toBe(1440)
  })

  it("TICK backdates correctly against the short day's own length, not a hardcoded 1440", () => {
    const dayFrame = resolveDayFrame("2024-03-10", "America/New_York")
    const catalog = [activity("Errand").rank(1).minutes(30).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    // now = the short day's own length: everything should have backdated to
    // COMPLETED, not be waiting on a further 60 minutes that don't exist.
    const ticked = solve({
      dayFrame,
      now: dayFrame.lengthMinutes,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })

    const errand = ticked.timeline.instances[0]
    expect(errand.state).toBe("COMPLETED")
    expect(errand.completedSource).toBe("backdated")
  })
})
