import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

describe("solve — TICK (SPEC.md 9.2)", () => {
  it("is a no-op when nothing has passed yet: instances and revision are unchanged", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).strict("01:00", "02:00").build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    const ticked = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })

    expect(ticked.timeline.revision).toBe(generated.timeline.revision)
    expect(ticked.timeline.instances).toEqual(generated.timeline.instances)
  })

  it("marks a PLANNED instance ACTIVE once now enters its span, and a repeat tick at the same now is idempotent", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }) // Work: 00:00-01:00

    const tick1 = solve({
      dayFrame,
      now: 30,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })
    const work1 = tick1.timeline.instances.find((i) => i.name === "Work")!
    expect(work1.state).toBe("ACTIVE")
    expect(work1.actualStart).toBe(0)
    expect(tick1.timeline.revision).toBe(generated.timeline.revision + 1)

    const tick2 = solve({
      dayFrame,
      now: 30,
      catalog,
      existing: tick1.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: tick1.timeline.revision,
    })
    expect(tick2.timeline.revision).toBe(tick1.timeline.revision)
    expect(tick2.timeline.instances).toEqual(tick1.timeline.instances)
  })

  it("auto-completes a passed instance while a later one becomes ACTIVE, each anchored at its original placement", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).build(),
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

    const ticked = solve({
      dayFrame,
      now: 75,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })

    const work = ticked.timeline.instances.find((i) => i.name === "Work")!
    const gym = ticked.timeline.instances.find((i) => i.name === "Gym")!
    expect(work.state).toBe("COMPLETED")
    expect(work.completedSource).toBe("backdated")
    expect(work.actualStart).toBe(0)
    expect(work.actualEnd).toBe(60)
    expect(gym.state).toBe("ACTIVE")
    expect(gym.actualStart).toBe(60)
    expect(gym.plannedStart).toBe(60)
    expect(gym.plannedEnd).toBe(90)
  })

  it("re-solves a still-PLANNED activity deterministically to the same placement around anchored instances", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).build(),
      activity("Later").rank(2).minutes(30).build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }) // Work 00:00-01:00, Later 01:00-01:30

    const ticked = solve({
      dayFrame,
      now: 30,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })

    const later = ticked.timeline.instances.find((i) => i.name === "Later")!
    expect(later.state).toBe("PLANNED")
    expect(later.plannedStart).toBe(60)
    expect(later.plannedEnd).toBe(90)
  })

  it("preserves a SKIPPED instance's skip reason across a tick that changes nothing about it", () => {
    const catalog = [
      activity("Everything").rank(1).minutes(1440).build(),
      activity("Leftover").rank(2).minutes(30).build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    const ticked = solve({
      dayFrame,
      now: 100,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })

    const leftover = ticked.timeline.instances.find(
      (i) => i.name === "Leftover"
    )!
    expect(leftover.state).toBe("SKIPPED")
    expect(leftover.skipReason).toBe("NO_FREE_SPACE")
  })
})
