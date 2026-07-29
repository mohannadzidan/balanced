import { describe, expect, it } from "vitest"

import { DEFAULT_COST_CONSTANTS } from "@/app/brain/engine/constants"
import { solveChecked as solve } from "@/tests/brain/support/solve-checked"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")
const C = DEFAULT_COST_CONSTANTS

describe("solve — ADD_ADHOC (SPEC.md 9.5)", () => {
  it("places a one-off activity as activity_id: null, is_adhoc: true, without touching the catalogue", () => {
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
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Dentist",
          durationMinutes: 30,
          priorityRank: 2,
          rules: [],
          date: dayFrame.date,
        },
      },
      revision: generated.timeline.revision,
    })

    expect(result.status).not.toBe("REJECTED")
    const dentist = result.timeline.instances.find((i) => i.name === "Dentist")!
    expect(dentist.isAdhoc).toBe(true)
    expect(dentist.activityId).toBeNull()
    expect(dentist.state).toBe("PLANNED")
    expect(dentist.plannedStart).toBe(60)
    expect(dentist.plannedEnd).toBe(90)
    expect(result.timeline.revision).toBe(generated.timeline.revision + 1)

    // Work, from the catalogue, is untouched.
    const work = result.timeline.instances.find((i) => i.name === "Work")!
    expect(work.plannedStart).toBe(0)
    expect(work.plannedEnd).toBe(60)
  })

  it("supports the full rule vocabulary on an ad-hoc, e.g. a mandatory activity", () => {
    const result = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Urgent Call",
          durationMinutes: 30,
          priorityRank: 1,
          rules: [],
          requiredCount: 1,
          date: dayFrame.date,
        },
      },
    })

    expect(result.status).not.toBe("REJECTED")
    const call = result.timeline.instances.find(
      (i) => i.name === "Urgent Call"
    )!
    expect(call.state).toBe("PLANNED")
    expect(call.requiredCount).toBe(1)
  })

  it("rejects a payload with incompatible rules (SPEC.md 10.1 RULE_INCOMPATIBLE)", () => {
    const result = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Bad",
          durationMinutes: 30,
          priorityRank: 1,
          rules: [
            {
              type: "fixed",
              source: "instance",
              startWall: "09:00",
              endWall: "09:30",
            },
            {
              type: "window",
              source: "instance",
              days: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
              startWall: "09:00",
              endWall: "09:30",
              maxDriftMinutes: 0,
            },
          ],
          date: dayFrame.date,
        },
      },
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
    expect(result.timeline.instances).toEqual([])
  })

  it("rejects a payload whose priority rank collides with an existing activity", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Collides",
          durationMinutes: 30,
          priorityRank: 1,
          rules: [],
          date: dayFrame.date,
        },
      },
    })
    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT")
  })

  it("survives a later TICK instead of vanishing (it isn't in the catalogue)", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    const withAdhoc = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Dentist",
          durationMinutes: 30,
          priorityRank: 2,
          rules: [],
          date: dayFrame.date,
        },
      },
      revision: generated.timeline.revision,
    })
    const dentist = withAdhoc.timeline.instances.find(
      (i) => i.name === "Dentist"
    )!
    expect(dentist.plannedStart).toBe(60)

    const ticked = solve({
      dayFrame,
      now: 10,
      catalog,
      existing: withAdhoc.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: withAdhoc.timeline.revision,
    })

    const stillThere = ticked.timeline.instances.find(
      (i) => i.name === "Dentist"
    )
    expect(stillThere).toBeDefined()
    expect(stillThere?.isAdhoc).toBe(true)
    expect(stillThere?.activityId).toBeNull()
    expect(stillThere?.plannedStart).toBe(60)
    expect(stillThere?.plannedEnd).toBe(90)
  })

  it("recomputes the totalRanked-derived skip weight of existing activities once the ad-hoc joins the ranked count (SPEC-v2.md 7.3 invariant 3)", () => {
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
    const leftoverBefore = generated.timeline.instances.find(
      (i) => i.name === "Leftover"
    )!
    expect(leftoverBefore.state).toBe("SKIPPED")
    // totalRanked = 2, weight = priorityWeight(2, 2) = 1
    expect(generated.cost.perInstance[leftoverBefore.id]).toBe(1 * C.SKIP)

    const withAdhoc = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Extra",
          durationMinutes: 30,
          priorityRank: 3,
          rules: [],
          date: dayFrame.date,
        },
      },
      revision: generated.timeline.revision,
    })
    const leftoverAfter = withAdhoc.timeline.instances.find(
      (i) => i.name === "Leftover"
    )!
    expect(leftoverAfter.state).toBe("SKIPPED")
    // totalRanked is now 3 (2 catalog activities + 1 ad-hoc), so Leftover's
    // weight changes from priorityWeight(2, 2) = 1 to priorityWeight(2, 3) =
    // 2 — proving the ad-hoc's totalRanked+1 recomputation reaches every
    // instance's cost, not just the new ad-hoc's own weight.
    expect(withAdhoc.cost.perInstance[leftoverAfter.id]).toBe(2 * C.SKIP)
  })

  it("gives successive ad-hocs distinct ids", () => {
    const first = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "First",
          durationMinutes: 30,
          priorityRank: 1,
          rules: [],
          date: dayFrame.date,
        },
      },
    })

    const second = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: first.timeline.instances,
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Second",
          durationMinutes: 30,
          priorityRank: 2,
          rules: [],
          date: dayFrame.date,
        },
      },
      revision: first.timeline.revision,
    })

    const ids = second.timeline.instances.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
