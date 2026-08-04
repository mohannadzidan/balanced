import { describe, expect, it } from "vitest"

import {
  placementCost,
  priorityWeight,
  scheduleCost,
  skipCost,
  violatesDominance,
} from "../src/engine/cost"
import { DEFAULT_COST_CONSTANTS } from "../src/engine/constants"
import type { TimelineActivity } from "../src/engine/types"
import { activity } from "./support/fixtures"

const C = DEFAULT_COST_CONSTANTS

describe("priorityWeight", () => {
  it.each([
    [1, 6, 6],
    [6, 6, 1],
    [3, 6, 4],
  ])("rank %i of %i ranked activities weighs %i", (rank, total, expected) => {
    expect(priorityWeight(rank, total)).toBe(expected)
  })
})

describe("placementCost", () => {
  it.each([
    [
      "full duration, no relaxation",
      60,
      { scheduledMinutes: 60, chunkCount: 1, driftMinutes: 0, gapMinutes: 0 },
      0,
    ],
    [
      "shrunk by 15 minutes",
      60,
      { scheduledMinutes: 45, chunkCount: 1, driftMinutes: 0, gapMinutes: 0 },
      C.SHRINK * 15,
    ],
    [
      "split into two chunks",
      60,
      { scheduledMinutes: 60, chunkCount: 2, driftMinutes: 0, gapMinutes: 0 },
      C.CHUNK * 1,
    ],
    [
      "drifted 15 minutes",
      60,
      { scheduledMinutes: 60, chunkCount: 1, driftMinutes: 15, gapMinutes: 0 },
      C.DRIFT * 15,
    ],
    [
      "10 minute sequence gap",
      60,
      { scheduledMinutes: 60, chunkCount: 1, driftMinutes: 0, gapMinutes: 10 },
      C.GAP * 10,
    ],
    [
      "shrink and drift combined",
      60,
      { scheduledMinutes: 45, chunkCount: 1, driftMinutes: 10, gapMinutes: 0 },
      C.SHRINK * 15 + C.DRIFT * 10,
    ],
  ])("%s", (_label, duration, evaluation, expectedAtWeight1) => {
    expect(placementCost(duration, 1, evaluation, C)).toBe(expectedAtWeight1)
    expect(placementCost(duration, 3, evaluation, C)).toBe(
      expectedAtWeight1 * 3
    )
  })
})

describe("skipCost", () => {
  it("charges W(a) * SKIP for an ordinary skip", () => {
    expect(skipCost(4, C, { isRequired: false, isDependentSkip: false })).toBe(
      4 * C.SKIP
    )
  })

  it("charges infinity for a skipped required activity", () => {
    expect(skipCost(4, C, { isRequired: true, isDependentSkip: false })).toBe(
      Number.POSITIVE_INFINITY
    )
  })

  it("is free for a dependent skipped because its host was skipped", () => {
    expect(skipCost(4, C, { isRequired: true, isDependentSkip: true })).toBe(0)
  })
})

function instance(overrides: Partial<TimelineActivity>): TimelineActivity {
  return {
    id: "id",
    activityId: null,
    date: "2024-06-15",
    name: "Activity",
    durationMinutes: 60,
    priorityRank: 1,
    requiredCount: 0,
    rules: [],
    state: "PLANNED",
    completedSource: null,
    plannedStart: 0,
    plannedEnd: 60,
    actualStart: null,
    actualEnd: null,
    scheduledMinutes: 60,
    occurrenceId: "id@2024-06-15#1",
    occurrenceIndex: 1,
    bucketKey: "2024-06-15",
    blockIndex: 1,
    blockCount: 1,
    chunkGroupId: null,
    hostInstanceId: null,
    isAdhoc: false,
    spanningFromPreviousDay: false,
    relaxations: [],
    locked: false,
    skipReason: null,
    ...overrides,
  }
}

describe("scheduleCost", () => {
  it("charges idle for every uncovered minute of an empty day", () => {
    const result = scheduleCost([], 1440, 0, C)
    expect(result).toEqual({
      total: 1440,
      skip: 0,
      shrink: 0,
      chunk: 0,
      drift: 0,
      gap: 0,
      idle: 1440,
      perInstance: {},
    })
  })

  it("aggregates shrink, drift, gap, and skip across instances", () => {
    const instances = [
      instance({
        id: "gym",
        priorityRank: 1,
        durationMinutes: 60,
        scheduledMinutes: 45,
        plannedStart: 0,
        plannedEnd: 45,
        relaxations: [{ type: "shrink", minutes: 15 }],
      }),
      instance({
        id: "commute",
        priorityRank: 2,
        durationMinutes: 30,
        scheduledMinutes: 30,
        plannedStart: 45,
        plannedEnd: 75,
        relaxations: [{ type: "drift", minutes: 10 }],
      }),
      instance({
        id: "reading",
        priorityRank: 3,
        state: "SKIPPED",
        plannedStart: null,
        plannedEnd: null,
        scheduledMinutes: 0,
        skipReason: "NO_FREE_SPACE",
      }),
    ]

    const result = scheduleCost(instances, 1440, 3, C)

    const weightGym = priorityWeight(1, 3) // 3
    const weightCommute = priorityWeight(2, 3) // 2
    const weightReading = priorityWeight(3, 3) // 1

    expect(result.shrink).toBe(weightGym * C.SHRINK * 15)
    expect(result.drift).toBe(weightCommute * C.DRIFT * 10)
    expect(result.skip).toBe(weightReading * C.SKIP)
    expect(result.idle).toBe((1440 - 75) * C.IDLE)
    expect(result.total).toBe(
      result.shrink +
        result.chunk +
        result.drift +
        result.gap +
        result.skip +
        result.idle
    )
    expect(result.perInstance.gym).toBe(weightGym * C.SHRINK * 15)
    expect(result.perInstance.reading).toBe(weightReading * C.SKIP)
  })

  it("charges nothing for a dependent skipped because its host was skipped", () => {
    const instances = [
      instance({
        id: "commute",
        priorityRank: 1,
        state: "SKIPPED",
        plannedStart: null,
        plannedEnd: null,
        scheduledMinutes: 0,
        skipReason: "HOST_SKIPPED",
      }),
    ]
    const result = scheduleCost(instances, 1440, 1, C)
    expect(result.skip).toBe(0)
  })
})

describe("violatesDominance", () => {
  it("holds for a reasonably configured activity", () => {
    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .shrink({ floor: 45 })
      .build()
    expect(violatesDominance(gym, C)).toBe(false)
  })

  it("holds for an activity with no relaxation rules at all", () => {
    const plain = activity("Plain").rank(1).minutes(60).build()
    expect(violatesDominance(plain, C)).toBe(false)
  })

  it("fires from a sequence rule's max gap alone, with no shrink or drift involved", () => {
    // GAP * 2001 = 10,005 > SKIP (10,000), on its own.
    const dependent = activity("Dependent")
      .rank(1)
      .minutes(200)
      .sequence("post", "host", { maxGap: 2001 })
      .build()
    expect(violatesDominance(dependent, C)).toBe(true)

    // The same activity without the sequence rule holds, confirming the gap
    // term — not some other relaxation — was what tipped it over.
    const withoutSequence = activity("Dependent").rank(1).minutes(200).build()
    expect(violatesDominance(withoutSequence, C)).toBe(false)
  })

  it("fires for a deliberately broken activity whose shrink alone outprices skipping", () => {
    // duration 1000, shrink floor 0: SHRINK * 1000 = 20 * 1000 = 20,000 > SKIP (10,000)
    const broken = activity("Broken")
      .rank(1)
      .minutes(1000)
      .shrink({ floor: 0 })
      .build()
    expect(violatesDominance(broken, C)).toBe(true)
  })
})
