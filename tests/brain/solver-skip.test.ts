import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

describe("solve — SKIP (SPEC.md 9.7)", () => {
  it("marks a PLANNED instance user-skipped, freeing its time for a lower-priority activity", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).build(),
      activity("Gym").rank(2).minutes(60).build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }) // Work 00:00-01:00, Gym 01:00-02:00

    const work = generated.timeline.instances.find((i) => i.name === "Work")!
    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "SKIP", instanceId: work.id },
      revision: generated.timeline.revision,
    })

    expect(result.status).not.toBe("REJECTED")
    const skippedWork = result.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(skippedWork.state).toBe("SKIPPED")
    expect(skippedWork.skipReason).toBe("USER_SKIPPED")
    expect(skippedWork.locked).toBe(true)

    const gym = result.timeline.instances.find((i) => i.name === "Gym")!
    expect(gym.state).toBe("PLANNED")
    expect(gym.plannedStart).toBe(0)
    expect(gym.plannedEnd).toBe(60)
    expect(result.timeline.revision).toBe(generated.timeline.revision + 1)
  })

  it("keeps a user skip pinned across a later TICK, unlike an ordinary auto-skip", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const work = generated.timeline.instances.find((i) => i.name === "Work")!

    const skipped = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "SKIP", instanceId: work.id },
      revision: generated.timeline.revision,
    })

    const ticked = solve({
      dayFrame,
      now: 500,
      catalog,
      existing: skipped.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: skipped.timeline.revision,
    })

    const stillSkipped = ticked.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(stillSkipped.state).toBe("SKIPPED")
    expect(stillSkipped.skipReason).toBe("USER_SKIPPED")
  })

  it("rejects with UNKNOWN_INSTANCE for an id that isn't in the timeline", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "SKIP", instanceId: "does-not-exist" },
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("UNKNOWN_INSTANCE")
    expect(result.timeline.instances).toEqual([])
  })

  it("rejects with INVALID_STATE_FOR_EVENT when the instance isn't PLANNED", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const work = generated.timeline.instances.find((i) => i.name === "Work")!

    const activeTick = solve({
      dayFrame,
      now: 30,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })

    const result = solve({
      dayFrame,
      now: 30,
      catalog,
      existing: activeTick.timeline.instances,
      carryIn: [],
      event: { type: "SKIP", instanceId: work.id },
      revision: activeTick.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
    expect(result.timeline.instances).toEqual(activeTick.timeline.instances)
  })
})

describe("solve — RESTORE (SPEC.md 9.7)", () => {
  it("lifts a user skip and re-solves the activity back into the day", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).build(),
      activity("Gym").rank(2).minutes(60).build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const work = generated.timeline.instances.find((i) => i.name === "Work")!

    const skipped = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "SKIP", instanceId: work.id },
      revision: generated.timeline.revision,
    })
    const skippedWork = skipped.timeline.instances.find(
      (i) => i.name === "Work"
    )!

    const restored = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: skipped.timeline.instances,
      carryIn: [],
      event: { type: "RESTORE", instanceId: skippedWork.id },
      revision: skipped.timeline.revision,
    })

    const restoredWork = restored.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(restoredWork.state).toBe("PLANNED")
    expect(restoredWork.locked).toBe(false)
    expect(restored.timeline.revision).toBe(skipped.timeline.revision + 1)
  })

  it("can displace and reject a different, previously-fine sequence dependent (SPEC.md 9.7's hedge)", () => {
    // Work (unconstrained, greedy) and Filler (fixed 02:00-02:30) leave a
    // gap at [01:30, 02:00) that Report (sequence-post of Work, max_gap 0)
    // claims — as long as Work lands at [00:30, 01:30). Restricted starts
    // there only by the freeze boundary at generate time (now=30), Restore
    // (mandatory, strict 00:00-01:00) starts out infeasible and auto-
    // skipped, unrelated to Work or Report. Restoring it at now=0 lets it
    // finally claim [0, 60) — pushing Work's cheapest slot from [30, 90) to
    // [60, 120), which collides with Filler's [120, 150) start... no room
    // left for Report to reattach at zero gap.
    const catalog = [
      activity("Work").rank(1).minutes(60).build(),
      activity("Report")
        .rank(2)
        .minutes(30)
        .sequence("post", "work", { maxGap: 0 })
        .build(),
      activity("Restore")
        .rank(3)
        .minutes(60)
        .mandatory()
        .strict("00:00", "01:00")
        .build(),
      activity("Filler").rank(4).minutes(30).fixed("02:00", "02:30").build(),
    ]
    const generated = solve({
      dayFrame,
      now: 30,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const work = generated.timeline.instances.find((i) => i.name === "Work")!
    const report = generated.timeline.instances.find(
      (i) => i.name === "Report"
    )!
    const restore = generated.timeline.instances.find(
      (i) => i.name === "Restore"
    )!
    expect(work.plannedStart).toBe(30)
    expect(report.plannedStart).toBe(90)
    expect(restore.state).toBe("SKIPPED")
    expect(restore.skipReason).toBe("INFEASIBLE_HARD_CONSTRAINT")

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "RESTORE", instanceId: restore.id },
      revision: generated.timeline.revision,
    })

    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("SEQUENCE_UNSATISFIABLE")
    expect(result.timeline.instances).toEqual(generated.timeline.instances)
  })

  it("rejects with UNKNOWN_INSTANCE for an id that isn't in the timeline", () => {
    const result = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: { type: "RESTORE", instanceId: "does-not-exist" },
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("UNKNOWN_INSTANCE")
  })

  it("rejects with INVALID_STATE_FOR_EVENT when the instance isn't SKIPPED", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const work = generated.timeline.instances.find((i) => i.name === "Work")!

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "RESTORE", instanceId: work.id },
      revision: generated.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
  })
})
