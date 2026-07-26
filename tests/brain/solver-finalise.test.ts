import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

describe("solve — FINALISE_DAY (SPEC.md 9.8)", () => {
  it("rejects with INVALID_STATE_FOR_EVENT before the day has ended", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    const result = solve({
      dayFrame,
      now: 100,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "FINALISE_DAY" },
      revision: generated.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
  })

  it("backdates completed residue and carries an activity still running past the day's end into tomorrow", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).fixed("00:00", "01:00").build(),
      activity("Gym").rank(2).minutes(30).build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }) // Work 00:00-01:00, Gym 01:00-01:30

    const active = solve({
      dayFrame,
      now: 10,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!
    expect(activeWork.state).toBe("ACTIVE")

    // Extend Work well past the day's own length, so it's still running
    // (not yet auto-completed) at the moment the day is finalised.
    const extended = solve({
      dayFrame,
      now: 10,
      catalog,
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "EXTEND", instanceId: activeWork.id, minutes: 1400 },
      revision: active.timeline.revision,
    })
    expect(extended.status).not.toBe("REJECTED")

    const finalised = solve({
      dayFrame,
      now: dayFrame.lengthMinutes,
      catalog,
      existing: extended.timeline.instances,
      carryIn: [],
      event: { type: "FINALISE_DAY" },
      revision: extended.timeline.revision,
    })

    expect(finalised.status).not.toBe("REJECTED")
    expect(finalised.timeline.finalised).toBe(true)

    // Work's extension consumes the rest of the day, so Gym has nowhere
    // left to go — a plain, correctly-reported skip, not a completion.
    const gym = finalised.timeline.instances.find((i) => i.name === "Gym")!
    expect(gym.state).toBe("SKIPPED")
    expect(gym.skipReason).toBe("NO_FREE_SPACE")

    const stillActiveWork = finalised.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(stillActiveWork.state).toBe("ACTIVE")

    const carriedWork = finalised.timeline.carryIn.find(
      (i) => i.name === "Work"
    )
    expect(carriedWork).toBeDefined()
    expect(carriedWork?.state).toBe("CARRIED_IN")
    expect(carriedWork?.spanningFromPreviousDay).toBe(true)
    expect(carriedWork?.durationMinutes).toBe(60)
  })

  it("refuses every further event against an already-finalised input", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    const result = solve({
      dayFrame,
      now: 100,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
      finalised: true,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("SPANS_FROZEN_REGION")
    expect(result.timeline.instances).toEqual(generated.timeline.instances)
  })
})
