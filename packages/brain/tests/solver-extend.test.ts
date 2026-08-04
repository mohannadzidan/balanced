import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "./support/solve-checked"
import { resolveDayFrame } from "../src/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

function activate(
  catalog: ReturnType<typeof activity>[],
  existing: Parameters<typeof solve>[0]["existing"],
  revision: number,
  now: number
) {
  return solve({
    dayFrame,
    now,
    catalog: catalog.map((b) => b.build()),
    existing,
    carryIn: [],
    event: { type: "TICK" },
    revision,
  })
}

describe("solve — EXTEND (SPEC.md 9.4)", () => {
  it("pushes the active instance's planned end out and displaces what came after it", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60),
      activity("Gym").rank(2).minutes(30),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog: catalog.map((b) => b.build()),
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }) // Work 00:00-01:00, Gym 01:00-01:30
    const active = activate(
      catalog,
      generated.timeline.instances,
      generated.timeline.revision,
      10
    )
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!

    const extended = solve({
      dayFrame,
      now: 10,
      catalog: catalog.map((b) => b.build()),
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "EXTEND", instanceId: activeWork.id, minutes: 15 },
      revision: active.timeline.revision,
    })

    expect(extended.status).not.toBe("REJECTED")
    const extendedWork = extended.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(extendedWork.state).toBe("ACTIVE")
    expect(extendedWork.plannedStart).toBe(0)
    expect(extendedWork.plannedEnd).toBe(75)

    const gym = extended.timeline.instances.find((i) => i.name === "Gym")!
    expect(gym.plannedStart).toBe(75)
    expect(gym.plannedEnd).toBe(105)
    expect(extended.timeline.revision).toBe(active.timeline.revision + 1)
  })

  it("rejects with UNKNOWN_INSTANCE for an id that isn't in the timeline", () => {
    const result = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: { type: "EXTEND", instanceId: "nope", minutes: 15 },
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("UNKNOWN_INSTANCE")
  })

  it("rejects with INVALID_STATE_FOR_EVENT when the instance isn't ACTIVE", () => {
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
      event: { type: "EXTEND", instanceId: work.id, minutes: 15 },
      revision: generated.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
  })

  it("rejects with INVALID_STATE_FOR_EVENT when minutes isn't a positive multiple of the grid", () => {
    const catalog = [activity("Work").rank(1).minutes(60)]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog: catalog.map((b) => b.build()),
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const active = activate(
      catalog,
      generated.timeline.instances,
      generated.timeline.revision,
      10
    )
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!

    const result = solve({
      dayFrame,
      now: 10,
      catalog: catalog.map((b) => b.build()),
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "EXTEND", instanceId: activeWork.id, minutes: 7 },
      revision: active.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
  })

  it("rejects with MANDATORY_UNPLACEABLE when extending would newly displace a mandatory activity", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).fixed("00:00", "01:00"),
      activity("Checkup").rank(2).minutes(1380).mandatory(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog: catalog.map((b) => b.build()),
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }) // Work fixed 00:00-01:00, Checkup fills the rest of the day (mandatory)
    const checkup = generated.timeline.instances.find(
      (i) => i.name === "Checkup"
    )!
    expect(checkup.state).toBe("PLANNED")

    const active = activate(
      catalog,
      generated.timeline.instances,
      generated.timeline.revision,
      10
    )
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!

    const result = solve({
      dayFrame,
      now: 10,
      catalog: catalog.map((b) => b.build()),
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "EXTEND", instanceId: activeWork.id, minutes: 60 },
      revision: active.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("MANDATORY_UNPLACEABLE")
    expect(result.timeline.instances).toEqual(active.timeline.instances)
  })
})
