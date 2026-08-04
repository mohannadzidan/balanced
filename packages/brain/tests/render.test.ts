import { describe, expect, it } from "vitest";

import { renderAscii } from "../src/engine/render";
import { resolveDayFrame } from "../src/engine/time";
import type { Timeline, TimelineActivity } from "../src/engine/types";

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
  };
}

describe("renderAscii", () => {
  it("prints a hand-built timeline deterministically", () => {
    const dayFrame = resolveDayFrame("2024-06-15", "UTC");
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
      carryIn: [],
    };

    expect(renderAscii(timeline)).toBe(
      [
        "09:00 ├ Work  480m  09:00-17:00",
        "      │   └ 09:00-09:30   Email",
        "      ✗ Reading  SKIPPED — NO_FREE_SPACE",
        "",
        "cost: total 100 | skip 0 | shrink 0 | chunk 0 | drift 0 | gap 0 | idle 100",
        "status: OK",
      ].join("\n"),
    );
  });

  it("sorts multiple skipped instances by priority rank, and prints a placed instance's relaxations and multiple sorted guests", () => {
    const dayFrame = resolveDayFrame("2024-06-15", "UTC");
    const timeline: Timeline = {
      dayFrame,
      revision: 1,
      instances: [
        instance({
          id: "work",
          name: "Work",
          plannedStart: 540,
          plannedEnd: 600,
          relaxations: [{ type: "shrink", minutes: 15 }],
        }),
        instance({
          id: "later-guest",
          name: "Later Guest",
          hostInstanceId: "work",
          plannedStart: 570,
          plannedEnd: 580,
        }),
        instance({
          id: "earlier-guest",
          name: "Earlier Guest",
          hostInstanceId: "work",
          plannedStart: 550,
          plannedEnd: 560,
        }),
        instance({
          id: "low-priority-skip",
          name: "Low Priority",
          priorityRank: 5,
          state: "SKIPPED",
          plannedStart: null,
          plannedEnd: null,
          scheduledMinutes: 0,
          skipReason: "NO_FREE_SPACE",
        }),
        instance({
          id: "high-priority-skip",
          name: "High Priority",
          priorityRank: 1,
          state: "SKIPPED",
          plannedStart: null,
          plannedEnd: null,
          scheduledMinutes: 0,
          skipReason: "NO_FREE_SPACE",
        }),
      ],
      diagnostics: [],
      cost: {
        total: 0,
        skip: 0,
        shrink: 0,
        chunk: 0,
        drift: 0,
        gap: 0,
        idle: 0,
        perInstance: {},
      },
      status: "OK",
      solvedAtOffset: 0,
      finalised: false,
      carryIn: [],
    };

    const rendered = renderAscii(timeline);
    expect(rendered).toContain("Work  60m  09:00-10:00  (shrink 15m)");
    // Guests print earliest-first regardless of instance array order.
    const earlierIdx = rendered.indexOf("Earlier Guest");
    const laterIdx = rendered.indexOf("Later Guest");
    expect(earlierIdx).toBeGreaterThan(-1);
    expect(laterIdx).toBeGreaterThan(earlierIdx);
    // Skipped instances print in ascending priority-rank order.
    const highIdx = rendered.indexOf("High Priority");
    const lowIdx = rendered.indexOf("Low Priority");
    expect(highIdx).toBeGreaterThan(-1);
    expect(lowIdx).toBeGreaterThan(highIdx);
  });

  it("is a pure function of the timeline value", () => {
    const dayFrame = resolveDayFrame("2024-06-15", "UTC");
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
      carryIn: [],
    };
    expect(renderAscii(timeline)).toBe(renderAscii(timeline));
  });
});
