import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import type { OverlapRule } from "@/app/brain/engine/types"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

describe("solve — EDIT_INSTANCE_RULES (SPEC.md 9.6)", () => {
  it("lets a newly-permitted guest nest into Work after the rule is edited", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: [] })
        .build(),
      activity("Email")
        .id("email")
        .rank(2)
        .minutes(30)
        .strict("09:00", "09:30")
        .build(),
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
    const email = generated.timeline.instances.find((i) => i.name === "Email")!
    expect(email.hostInstanceId).toBeNull() // not yet an allowed guest
    const currentOverlap = work.rules.find(
      (r): r is OverlapRule => r.type === "overlap"
    )!

    const edited = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "EDIT_INSTANCE_RULES",
        instanceId: work.id,
        rules: [{ ...currentOverlap, allowedGuestIds: ["email"] }],
      },
      revision: generated.timeline.revision,
    })

    expect(edited.status).not.toBe("REJECTED")
    const nestedEmail = edited.timeline.instances.find(
      (i) => i.name === "Email"
    )!
    expect(nestedEmail.hostInstanceId).toBe(work.id)
    expect(nestedEmail.plannedStart).toBe(540)
    expect(nestedEmail.plannedEnd).toBe(570)
  })

  it("lets a guest nest into an already-ACTIVE host once the rule is edited", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .fixed("09:00", "17:00")
        .overlap({ budget: 60, guests: [] })
        .build(),
      activity("Email")
        .id("email")
        .rank(2)
        .minutes(30)
        .strict("09:20", "10:00")
        .build(),
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

    const activated = solve({
      dayFrame,
      now: 560,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })
    const activeWork = activated.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(activeWork.state).toBe("ACTIVE")
    const currentOverlap = activeWork.rules.find(
      (r): r is OverlapRule => r.type === "overlap"
    )!

    const edited = solve({
      dayFrame,
      now: 560,
      catalog,
      existing: activated.timeline.instances,
      carryIn: [],
      event: {
        type: "EDIT_INSTANCE_RULES",
        instanceId: work.id,
        rules: [{ ...currentOverlap, allowedGuestIds: ["email"] }],
      },
      revision: activated.timeline.revision,
    })

    expect(edited.status).not.toBe("REJECTED")
    const nestedEmail = edited.timeline.instances.find(
      (i) => i.name === "Email"
    )!
    expect(nestedEmail.hostInstanceId).toBe(work.id)
    const stillActiveWork = edited.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(stillActiveWork.state).toBe("ACTIVE")
  })

  it("persists the override across a later TICK without replaying the edit", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: [] })
        .build(),
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

    const edited = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "EDIT_INSTANCE_RULES",
        instanceId: work.id,
        rules: [
          {
            type: "overlap",
            source: "instance",
            budgetMinutes: 90,
            allowedGuestIds: ["someone"],
            exclusionWindows: [],
          },
        ],
      },
      revision: generated.timeline.revision,
    })

    const ticked = solve({
      dayFrame,
      now: 30,
      catalog,
      existing: edited.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: edited.timeline.revision,
    })

    const workAfterTick = ticked.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    const overlap = workAfterTick.rules.find(
      (r): r is OverlapRule => r.type === "overlap"
    )!
    expect(overlap.source).toBe("instance")
    expect(overlap.budgetMinutes).toBe(90)
    expect(overlap.allowedGuestIds).toEqual(["someone"])
  })

  it("rejects with INVALID_STATE_FOR_EVENT for a COMPLETED instance", () => {
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

    const ticked = solve({
      dayFrame,
      now: 100, // past Work's 00:00-01:00 span — backdated to COMPLETED
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })
    const completedWork = ticked.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(completedWork.state).toBe("COMPLETED")

    const result = solve({
      dayFrame,
      now: 100,
      catalog,
      existing: ticked.timeline.instances,
      carryIn: [],
      event: { type: "EDIT_INSTANCE_RULES", instanceId: work.id, rules: [] },
      revision: ticked.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
  })

  it("leaves an unrelated catalog activity's rules untouched by another activity's override", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: [] })
        .build(),
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
    const gymBefore = generated.timeline.instances.find(
      (i) => i.name === "Gym"
    )!

    const edited = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "EDIT_INSTANCE_RULES",
        instanceId: work.id,
        rules: [
          {
            type: "overlap",
            source: "instance",
            budgetMinutes: 90,
            allowedGuestIds: ["someone"],
            exclusionWindows: [],
          },
        ],
      },
      revision: generated.timeline.revision,
    })

    const gymAfter = edited.timeline.instances.find((i) => i.name === "Gym")!
    expect(gymAfter.plannedStart).toBe(gymBefore.plannedStart)
    expect(gymAfter.plannedEnd).toBe(gymBefore.plannedEnd)
    expect(gymAfter.rules).toEqual(gymBefore.rules)
  })

  it("rejects with UNKNOWN_INSTANCE for an id that isn't in the timeline", () => {
    const result = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: { type: "EDIT_INSTANCE_RULES", instanceId: "nope", rules: [] },
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("UNKNOWN_INSTANCE")
  })

  it("rejects with INVALID_STATE_FOR_EVENT for an ad-hoc instance (no template to override)", () => {
    const generated = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Dentist",
          durationMinutes: 30,
          priorityRank: 1,
          rules: [],
          date: dayFrame.date,
        },
      },
    })
    const dentist = generated.timeline.instances.find(
      (i) => i.name === "Dentist"
    )!

    const result = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "EDIT_INSTANCE_RULES",
        instanceId: dentist.id,
        rules: [],
      },
      revision: generated.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
  })

  it("rejects an edit that would make the activity's rules incompatible", () => {
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
      event: {
        type: "EDIT_INSTANCE_RULES",
        instanceId: work.id,
        rules: [
          {
            type: "fixed",
            source: "instance",
            startWall: "09:03",
            endWall: "10:00",
          },
        ],
      },
      revision: generated.timeline.revision,
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
  })
})
