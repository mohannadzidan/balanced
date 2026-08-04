import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "./support/solve-checked"
import { resolveDayFrame } from "../src/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

describe("solve — event-time rejection (SPEC.md 10.2)", () => {
  it("rejects ADD_ADHOC with MANDATORY_UNPLACEABLE when a fixed ad-hoc squeezes out a mandatory activity (worked example 14.4)", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .strict("09:00", "18:00")
        .mandatory()
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
    expect(work.state).toBe("PLANNED")

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Doctor",
          durationMinutes: 60,
          priorityRank: 2,
          rules: [
            {
              type: "fixed",
              source: "instance",
              startWall: "10:00",
              endWall: "11:00",
            },
          ],
          date: dayFrame.date,
        },
      },
      revision: generated.timeline.revision,
    })

    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("MANDATORY_UNPLACEABLE")
    expect(result.rejection?.conflictingInstanceIds).toEqual([work.id])
    expect(result.timeline.instances).toEqual(generated.timeline.instances)

    const bestEffort = result.rejection?.bestEffortTimeline
    expect(bestEffort).not.toBeNull()
    const bestEffortWork = bestEffort?.instances.find((i) => i.name === "Work")
    expect(bestEffortWork?.state).toBe("SKIPPED")
  })

  it("rejects EDIT_INSTANCE_RULES with FIXED_COLLISION when the new fixed time collides with another fixed activity", () => {
    const catalog = [
      activity("Standup").rank(1).minutes(30).fixed("09:00", "09:30").build(),
      activity("Work").rank(2).minutes(30).build(),
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
    expect(work.state).toBe("PLANNED")

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
            startWall: "09:00",
            endWall: "09:30",
          },
        ],
      },
      revision: generated.timeline.revision,
    })

    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("FIXED_COLLISION")
    expect(result.timeline.instances).toEqual(generated.timeline.instances)
  })

  it("rejects EDIT_INSTANCE_RULES with STRICT_WINDOW_VIOLATED when the edit leaves another strict-window activity unplaceable", () => {
    // Work outranks Meeting, so once Work's edited window encroaches on
    // Meeting's slot, Work (placed first, in priority order) keeps its spot
    // and Meeting — the bystander — is the one left unplaceable.
    const catalog = [
      activity("Work").rank(1).minutes(480).strict("09:30", "17:30").build(),
      activity("Meeting").rank(2).minutes(30).strict("09:00", "09:30").build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const meeting = generated.timeline.instances.find(
      (i) => i.name === "Meeting"
    )!
    const work = generated.timeline.instances.find((i) => i.name === "Work")!
    expect(meeting.state).toBe("PLANNED")
    expect(meeting.plannedStart).toBe(540) // 09:00
    expect(work.plannedStart).toBe(570) // 09:30, adjacent, no overlap yet

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
            type: "window",
            source: "instance",
            days: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
            startWall: "09:15",
            endWall: "17:15",
            maxDriftMinutes: 0,
          },
        ],
      },
      revision: generated.timeline.revision,
    })

    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("STRICT_WINDOW_VIOLATED")
    expect(result.rejection?.conflictingInstanceIds).toEqual([meeting.id])
  })

  it("rejects EDIT_INSTANCE_RULES with GUEST_WINDOW_VIOLATED when moving the host pushes a nested guest outside its own strict window", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email"] })
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
    expect(email.hostInstanceId).toBe(work.id)
    expect(email.plannedStart).toBe(540) // 09:00

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
            type: "window",
            source: "instance",
            days: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
            startWall: "09:15",
            endWall: "17:15",
            maxDriftMinutes: 0,
          },
        ],
      },
      revision: generated.timeline.revision,
    })

    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("GUEST_WINDOW_VIOLATED")
    expect(result.rejection?.conflictingInstanceIds).toEqual([email.id])
  })

  it("rejects ADD_ADHOC with SEQUENCE_UNSATISFIABLE when a fixed block takes the only adjacent slot for a sequence dependent", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).strict("09:00", "10:00").build(),
      activity("Commute").rank(2).minutes(30).sequence("pre", "work").build(),
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
    const commute = generated.timeline.instances.find(
      (i) => i.name === "Commute"
    )!
    expect(work.state).toBe("PLANNED")
    expect(commute.plannedStart).toBe(510) // 08:30, immediately before Work

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Blocker",
          durationMinutes: 30,
          priorityRank: 3,
          rules: [
            {
              type: "fixed",
              source: "instance",
              startWall: "08:30",
              endWall: "09:00",
            },
          ],
          date: dayFrame.date,
        },
      },
      revision: generated.timeline.revision,
    })

    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("SEQUENCE_UNSATISFIABLE")
    expect(result.rejection?.conflictingInstanceIds).toEqual([commute.id])
  })
})
