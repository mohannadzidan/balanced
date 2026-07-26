import { describe, expect, it } from "vitest"

import { renderAscii } from "@/app/brain/engine/render"
import { resolveDayFrame } from "@/app/brain/engine/time"
import type { Timeline, TimelineActivity } from "@/app/brain/engine/types"

function instance(overrides: Partial<TimelineActivity>): TimelineActivity {
  return {
    id: "id",
    activityId: null,
    date: "2024-06-15",
    name: "Activity",
    durationMinutes: 60,
    priorityRank: 1,
    rules: [],
    state: "PLANNED",
    completedSource: null,
    plannedStart: 0,
    plannedEnd: 60,
    actualStart: null,
    actualEnd: null,
    scheduledMinutes: 60,
    chunkIndex: 1,
    chunkCount: 1,
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

describe("renderAscii", () => {
  it("prints a hand-built timeline deterministically", () => {
    const dayFrame = resolveDayFrame("2024-06-15", "UTC")
    const timeline: Timeline = {
      dayFrame,
      revision: 1,
      instances: [
        instance({
          id: "work",
          name: "Work",
          plannedStart: 540,
          plannedEnd: 1020,
        }),
        instance({
          id: "email",
          name: "Email",
          hostInstanceId: "work",
          plannedStart: 540,
          plannedEnd: 570,
        }),
        instance({
          id: "reading",
          name: "Reading",
          state: "SKIPPED",
          plannedStart: null,
          plannedEnd: null,
          scheduledMinutes: 0,
          skipReason: "NO_FREE_SPACE",
        }),
      ],
      diagnostics: [],
      cost: {
        total: 100,
        skip: 0,
        shrink: 0,
        chunk: 0,
        drift: 0,
        gap: 0,
        idle: 100,
        perInstance: {},
      },
      status: "OK",
      solvedAtOffset: 0,
      finalised: false,
    }

    expect(renderAscii(timeline)).toBe(
      [
        "09:00 ├ Work  480m  09:00-17:00",
        "      │   └ 09:00-09:30   Email",
        "      ✗ Reading  SKIPPED — NO_FREE_SPACE",
        "",
        "cost: total 100 | skip 0 | shrink 0 | chunk 0 | drift 0 | gap 0 | idle 100",
        "status: OK",
      ].join("\n")
    )
  })

  it("is a pure function of the timeline value", () => {
    const dayFrame = resolveDayFrame("2024-06-15", "UTC")
    const timeline: Timeline = {
      dayFrame,
      revision: 1,
      instances: [],
      diagnostics: [],
      cost: {
        total: 1440,
        skip: 0,
        shrink: 0,
        chunk: 0,
        drift: 0,
        gap: 0,
        idle: 1440,
        perInstance: {},
      },
      status: "OK",
      solvedAtOffset: 0,
      finalised: false,
    }
    expect(renderAscii(timeline)).toBe(renderAscii(timeline))
  })
})
