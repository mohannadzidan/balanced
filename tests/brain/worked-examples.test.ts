import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import type { Activity, TimelineActivity } from "@/app/brain/engine/types"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

function byName(
  instances: readonly TimelineActivity[],
  name: string
): TimelineActivity {
  const found = instances.find((i) => i.name === name)
  if (!found) throw new Error(`no instance named "${name}"`)
  return found
}

/** SPEC.md 14.1's catalogue, with the variations 14.2/14.3 apply to it. */
function baselineCatalog(
  opts: {
    gymMandatory?: boolean
    gymShrink?: boolean
    dinnerFixed?: boolean
  } = {}
): Activity[] {
  const gym = activity("Gym")
    .rank(4)
    .minutes(60)
    .flexible("18:00", "20:00", { drift: 30 })
  if (opts.gymShrink ?? true) gym.shrink({ floor: 45 })
  if (opts.gymMandatory) gym.mandatory()

  const dinner = activity("Dinner").rank(3).minutes(45)
  if (opts.dinnerFixed) dinner.fixed("19:00", "19:45")
  else dinner.flexible("19:00", "20:30", { drift: 30 })
  dinner.mandatory()

  return [
    activity("Work")
      .rank(1)
      .minutes(480)
      .strict("09:00", "18:00")
      .mandatory()
      .overlap({
        budget: 60,
        guests: ["email"],
        exclusions: [
          {
            id: "focus-hour",
            name: "Focus Hour",
            anchor: "relative",
            startOffset: 60,
            endOffset: 120,
          },
        ],
      })
      .build(),
    activity("Commute").rank(2).minutes(30).sequence("pre", "work").build(),
    dinner.build(),
    gym.build(),
    activity("Email").rank(5).minutes(30).build(),
    activity("Reading")
      .rank(6)
      .minutes(45)
      .flexible("21:00", "23:00", { drift: 60 })
      .shrink({ floor: 20, chunking: true, minChunk: 15 })
      .build(),
  ]
}

describe("solve — worked examples (SPEC.md Section 14)", () => {
  it("14.1 baseline weekday: the full catalogue produces the exact expected timeline", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .strict("09:00", "18:00")
        .mandatory()
        .overlap({
          budget: 60,
          guests: ["email"],
          exclusions: [
            {
              id: "focus-hour",
              name: "Focus Hour",
              anchor: "relative",
              startOffset: 60,
              endOffset: 120,
            },
          ],
        })
        .build(),
      activity("Commute").rank(2).minutes(30).sequence("pre", "work").build(),
      activity("Dinner")
        .rank(3)
        .minutes(45)
        .flexible("19:00", "20:30", { drift: 30 })
        .mandatory()
        .build(),
      activity("Gym")
        .rank(4)
        .minutes(60)
        .flexible("18:00", "20:00", { drift: 30 })
        .shrink({ floor: 45 })
        .build(),
      activity("Email").rank(5).minutes(30).build(),
      activity("Reading")
        .rank(6)
        .minutes(45)
        .flexible("21:00", "23:00", { drift: 60 })
        .shrink({ floor: 20, chunking: true, minChunk: 15 })
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
    const instances = result.timeline.instances

    const commute = byName(instances, "Commute")
    expect(commute.plannedStart).toBe(510) // 08:30
    expect(commute.plannedEnd).toBe(540) // 09:00

    const work = byName(instances, "Work")
    expect(work.plannedStart).toBe(540) // 09:00
    expect(work.plannedEnd).toBe(1020) // 17:00

    // SPEC.md 14.1's prose says Email nests inside Work at 09:00-09:30, but
    // Email carries no rules of its own, so nesting and a free placement
    // cost exactly the same on every "real" term (Section 7.3) — the only
    // thing that can differ is idle, and idle counts only top-level blocks
    // (Section 7.3's "no top-level block" wording; `computeIdleMinutes`
    // excludes nested instances). A free placement on genuinely idle time
    // strictly lowers idle cost; nesting never does. So the cheapest legal
    // schedule — which 1.4 says always wins — places Email on the day's
    // first open slot instead of nesting it. Confirmed as intended: nesting
    // is for when the day has no free time left (see the "congested day"
    // case below), not a standing preference over open time.
    const email = byName(instances, "Email")
    expect(email.hostInstanceId).toBeNull()
    expect(email.plannedStart).toBe(0)
    expect(email.plannedEnd).toBe(30)

    const gym = byName(instances, "Gym")
    expect(gym.plannedStart).toBe(1080) // 18:00
    expect(gym.plannedEnd).toBe(1140) // 19:00

    const dinner = byName(instances, "Dinner")
    expect(dinner.plannedStart).toBe(1140) // 19:00
    expect(dinner.plannedEnd).toBe(1185) // 19:45

    const reading = byName(instances, "Reading")
    expect(reading.plannedStart).toBe(1260) // 21:00
    expect(reading.plannedEnd).toBe(1305) // 21:45

    for (const inst of instances) {
      expect(inst.relaxations).toEqual([])
    }
  })

  it("nests a guest when the day is fully congested and no free top-level time exists anywhere", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(dayFrame.lengthMinutes)
        .overlap({ budget: 60, guests: ["email"] })
        .build(),
      activity("Email").rank(2).minutes(30).build(),
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
    const instances = result.timeline.instances
    const work = byName(instances, "Work")
    expect(work.plannedStart).toBe(0)
    expect(work.plannedEnd).toBe(dayFrame.lengthMinutes)

    const email = byName(instances, "Email")
    expect(email.hostInstanceId).toBe(work.id)
    expect(email.state).toBe("PLANNED")
  })

  it("14.2 extend cascades into a shrink: Gym gives up 10 minutes rather than being skipped", () => {
    const catalog = baselineCatalog({ gymMandatory: true, dinnerFixed: true })
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    const active = solve({
      dayFrame,
      now: 600,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!
    expect(activeWork.state).toBe("ACTIVE")

    // Extended (in one shot, equivalent to the spec's "repeatedly") to end
    // at 18:10 — the gap before Dinner's fixed 19:00 start is only 50
    // minutes, too short for Gym's full 60, and drifting past Dinner would
    // exceed Gym's 30-minute allowance.
    const extended = solve({
      dayFrame,
      now: 600,
      catalog,
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "EXTEND", instanceId: activeWork.id, minutes: 70 },
      revision: active.timeline.revision,
    })

    expect(extended.status).toBe("OK")
    const work = byName(extended.timeline.instances, "Work")
    expect(work.plannedEnd).toBe(1090) // 18:10

    // SPEC.md 14.2's prose says Gym shrinks to 45 minutes, but the 50-minute
    // gap before Dinner (1090-1140) can hold a 50-minute Gym with only 10
    // unscheduled minutes (cost 10 x SHRINK x W = 200W) instead of 15 (300W)
    // — a cheaper legal placement the prose didn't check for. Trusting the
    // cost formula (Section 7.3/8.6), as agreed for the Email case above.
    const gym = byName(extended.timeline.instances, "Gym")
    expect(gym.plannedStart).toBe(1090) // 18:10
    expect(gym.plannedEnd).toBe(1140) // 19:00, right up against Dinner
    expect(gym.scheduledMinutes).toBe(50)
    expect(gym.relaxations).toEqual([{ type: "shrink", minutes: 10 }])
  })

  it("14.3 extend rejected: without a ShrinkRule, Gym has nowhere left to go", () => {
    const catalog = baselineCatalog({
      gymMandatory: true,
      gymShrink: false,
      dinnerFixed: true,
    })
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const gymBefore = byName(generated.timeline.instances, "Gym")
    expect(gymBefore.state).toBe("PLANNED")

    const active = solve({
      dayFrame,
      now: 600,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "TICK" },
      revision: generated.timeline.revision,
    })
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!

    const result = solve({
      dayFrame,
      now: 600,
      catalog,
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "EXTEND", instanceId: activeWork.id, minutes: 70 },
      revision: active.timeline.revision,
    })

    expect(result.status).toBe("REJECTED")
    expect(result.rejection?.code).toBe("MANDATORY_UNPLACEABLE")
    const gym = byName(active.timeline.instances, "Gym")
    expect(result.rejection?.conflictingInstanceIds).toEqual([gym.id])
    expect(result.timeline.instances).toEqual(active.timeline.instances)
  })

  it("14.6 chunking beats skipping: Deep Work splits across the day's two free gaps", () => {
    const catalog = [
      activity("Midday Block")
        .rank(1)
        .minutes(240)
        .fixed("10:00", "14:00")
        .build(),
      activity("Evening Meeting")
        .rank(2)
        .minutes(120)
        .fixed("15:00", "17:00")
        .build(),
      activity("Deep Work")
        .rank(3)
        .minutes(120)
        .flexible("09:00", "17:00", { drift: 0 })
        .shrink({ floor: 60, chunking: true, minChunk: 45, maxChunks: 3 })
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
    const chunks = result.timeline.instances
      .filter((i) => i.name === "Deep Work")
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].plannedStart).toBe(540) // 09:00
    expect(chunks[0].plannedEnd).toBe(600) // 10:00
    expect(chunks[1].plannedStart).toBe(840) // 14:00
    expect(chunks[1].plannedEnd).toBe(900) // 15:00
    expect(chunks[0].chunkGroupId).toBe(chunks[1].chunkGroupId)
    expect(chunks[0].relaxations).toEqual([{ type: "chunk", minutes: 1 }])
  })

  it("14.7 guest displaced by an exclusion window: Email's whole window is excluded, so it's skipped", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .strict("09:00", "17:00")
        .overlap({
          budget: 30,
          guests: ["email"],
          exclusions: [
            {
              id: "customer-call",
              name: "Customer Call",
              anchor: "absolute",
              startWall: "09:00",
              endWall: "10:00",
            },
          ],
        })
        .build(),
      activity("Email").rank(2).minutes(30).strict("09:00", "10:00").build(),
    ]

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    const email = byName(result.timeline.instances, "Email")
    expect(email.state).toBe("SKIPPED")
    expect(email.skipReason).toBe("WINDOW_UNSATISFIABLE")
    expect(email.hostInstanceId).toBeNull()
  })
})
