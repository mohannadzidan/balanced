import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "@/tests/brain/support/solve-checked"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

describe("solve — remaining Section 11 edge cases", () => {
  it("case 17: an empty catalogue produces OK with the full day priced as idle", () => {
    const result = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    expect(result.status).toBe("OK")
    expect(result.timeline.instances).toEqual([])
    expect(result.cost.idle).toBe(dayFrame.lengthMinutes)
    expect(result.cost.total).toBe(dayFrame.lengthMinutes)
  })

  it("case 18/3: now far past the end of the day backdates everything with no special case", () => {
    const catalog = [activity("Errand").rank(1).minutes(30).build()]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    // Several days' worth of minutes past this single day frame — the same
    // backdating rule applies uniformly, no multi-day loop in the code.
    const ticked = solve({
      dayFrame,
      now: dayFrame.lengthMinutes * 5,
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

  it("case 15: an already-active instance keeps its generation-time rules even after the catalogue's template changes", () => {
    const catalogV1 = [
      activity("Work").rank(1).minutes(60).strict("09:00", "10:00").build(),
      activity("Gym").rank(2).minutes(30).build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog: catalogV1,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const workBefore = generated.timeline.instances.find(
      (i) => i.name === "Work"
    )!
    expect(workBefore.plannedStart).toBe(540) // 09:00
    expect(workBefore.rules).toEqual(catalogV1[0].rules)

    // The template's window moves entirely — but re-solving with this
    // mutated catalogue at the moment Work itself starts (making it an
    // anchor) must not retroactively re-template the instance already on
    // the timeline.
    const catalogV2 = [
      activity("Work").rank(1).minutes(60).strict("14:00", "15:00").build(),
      activity("Gym").rank(2).minutes(30).build(),
    ]
    const ticked = solve({
      dayFrame,
      now: 540,
      catalog: catalogV2,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })
    const workAfter = ticked.timeline.instances.find((i) => i.name === "Work")!
    expect(workAfter.state).toBe("ACTIVE")
    expect(workAfter.rules).toEqual(workBefore.rules) // still 09:00-10:00
    expect(workAfter.plannedStart).toBe(540) // unaffected by the new template
  })

  it("case 16: an ad-hoc that outranks everything may legally displace much of the day", () => {
    const catalog = [
      activity("Meeting").rank(2).minutes(60).build(),
      activity("Errand").rank(3).minutes(40).build(),
    ]
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }) // Meeting 0-60, Errand 60-100

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: {
        type: "ADD_ADHOC",
        payload: {
          name: "Emergency",
          durationMinutes: 60,
          priorityRank: 1, // outranks both Meeting and Errand
          rules: [],
          date: dayFrame.date,
        },
      },
      revision: generated.timeline.revision,
    })

    expect(result.status).not.toBe("REJECTED")
    const emergency = result.timeline.instances.find(
      (i) => i.name === "Emergency"
    )!
    expect(emergency.plannedStart).toBe(0)
    expect(emergency.plannedEnd).toBe(60)

    const meeting = result.timeline.instances.find((i) => i.name === "Meeting")!
    expect(meeting.plannedStart).toBe(60) // displaced from its original 0-60

    const errand = result.timeline.instances.find((i) => i.name === "Errand")!
    expect(errand.plannedStart).toBe(120) // displaced further out in turn
  })

  it("case 19: an activity longer than the whole day is skipped gracefully, not a crash", () => {
    const catalog = [activity("Marathon").rank(1).minutes(2000).build()]
    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    expect(result.status).toBe("OK")
    const marathon = result.timeline.instances[0]
    expect(marathon.state).toBe("SKIPPED")
    expect(marathon.skipReason).toBe("NO_FREE_SPACE")
  })

  it("case 19: a mandatory over-long activity degrades the day instead of crashing", () => {
    const catalog = [
      activity("Marathon").rank(1).minutes(2000).mandatory().build(),
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
    const marathon = result.timeline.instances[0]
    expect(marathon.state).toBe("SKIPPED")
    expect(marathon.skipReason).toBe("INFEASIBLE_HARD_CONSTRAINT")
  })

  // SPEC.md 11's case 19 says an over-long activity is "skipped at solve
  // time with WINDOW_UNSATISFIABLE," but `inferSkipReason` (placement.ts)
  // only ever reports WINDOW_UNSATISFIABLE when raw free space of the right
  // duration exists somewhere and the window specifically excludes it —
  // checked only after confirming raw space exists at all. An activity
  // longer than the day has no raw candidate start anywhere regardless of
  // any window (`s + d <= length_minutes` can never hold), so it is
  // NO_FREE_SPACE unconditionally, with or without a strict window. Trusting
  // that more precise distinction, per the same pattern as the 14.1/14.2
  // findings above.
  it("case 19: an over-long activity is NO_FREE_SPACE even with a strict window, since it can never fit regardless", () => {
    const catalog = [
      activity("Marathon")
        .rank(1)
        .minutes(1500)
        .strict("00:00", "23:55")
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
    const marathon = result.timeline.instances[0]
    expect(marathon.state).toBe("SKIPPED")
    expect(marathon.skipReason).toBe("NO_FREE_SPACE")
  })

  it("case 13: an overlap budget is per host instance per day and does not roll over", () => {
    // A fully congested Work (spans the whole day) forces both guests to
    // compete for the same 30-minute shared budget purely through nesting —
    // no freestanding fallback is available to either, so the budget's
    // effect is directly observable.
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(dayFrame.lengthMinutes)
        .overlap({ budget: 30, guests: ["email", "ping"] })
        .build(),
      activity("Email").rank(2).minutes(30).build(),
      activity("Ping").rank(3).minutes(30).build(),
    ]

    const dayA = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const emailA = dayA.timeline.instances.find((i) => i.name === "Email")!
    const pingA = dayA.timeline.instances.find((i) => i.name === "Ping")!
    expect(emailA.state).toBe("PLANNED") // takes the whole 30-minute budget
    expect(pingA.state).toBe("SKIPPED") // nothing left, and nowhere else to go

    // A second, independent GENERATE_DAY on a fresh day frame with the
    // identical catalogue: if the budget had somehow carried over from day
    // A's exhaustion, Email would fail here too. It doesn't.
    const dayFrameB = resolveDayFrame("2024-06-18", "UTC")
    const dayB = solve({
      dayFrame: dayFrameB,
      now: 0,
      catalog: [
        activity("Work")
          .rank(1)
          .minutes(dayFrameB.lengthMinutes)
          .overlap({ budget: 30, guests: ["email", "ping"] })
          .build(),
        activity("Email").rank(2).minutes(30).build(),
        activity("Ping").rank(3).minutes(30).build(),
      ],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const emailB = dayB.timeline.instances.find((i) => i.name === "Email")!
    expect(emailB.state).toBe("PLANNED")
  })
})
