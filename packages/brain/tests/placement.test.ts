import { describe, expect, it } from "vitest";

import { DEFAULT_COST_CONSTANTS } from "../src/engine/constants";
import {
  enumerateCandidateStarts,
  enumerateFeasiblePlacements,
  enumerateFeasiblePlacementsForLength,
  evaluateCandidate,
  placeActivity,
  placeActivityWithFloor,
  type PlacementContext,
} from "../src/engine/placement";
import { resolveActivity } from "../src/engine/resolve";
import { resolveDayFrame } from "../src/engine/time";
import { activity } from "./support/fixtures";

const dayFrame = resolveDayFrame("2024-06-17", "UTC");
const C = DEFAULT_COST_CONSTANTS;

function baseContext(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    freeIntervals: [{ start: 0, end: 1440 }],
    freezeBoundary: 0,
    grid: 5,
    lengthMinutes: 1440,
    weight: 1,
    constants: C,
    ...overrides,
  };
}

describe("enumerateCandidateStarts", () => {
  it("enumerates every grid-aligned start that fits the duration", () => {
    expect(enumerateCandidateStarts(30, [{ start: 0, end: 100 }], 5)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70,
    ]);
  });

  it("rounds a non-grid-aligned interval start up to the grid", () => {
    expect(enumerateCandidateStarts(10, [{ start: 3, end: 20 }], 5)).toEqual([5, 10]);
  });

  it("returns nothing when the interval is shorter than the duration", () => {
    expect(enumerateCandidateStarts(60, [{ start: 0, end: 30 }], 5)).toEqual([]);
  });
});

describe("placeActivity — duration and priority only (no window rules)", () => {
  it("places at the earliest legal start", () => {
    const resolved = resolveActivity(activity("Work").rank(1).minutes(60).build(), dayFrame);
    const result = placeActivity(resolved, baseContext());
    expect(result).toEqual({
      placement: { start: 0, end: 60, nestedIn: null },
      skipReason: null,
    });
  });

  it("never starts before the freeze boundary", () => {
    const resolved = resolveActivity(activity("Work").rank(1).minutes(60).build(), dayFrame);
    const result = placeActivity(resolved, baseContext({ freezeBoundary: 50 }));
    expect(result.placement).toEqual({ start: 50, end: 110, nestedIn: null });
  });

  it("reports NO_FREE_SPACE when nothing fits", () => {
    const resolved = resolveActivity(activity("Work").rank(1).minutes(60).build(), dayFrame);
    const result = placeActivity(resolved, baseContext({ freeIntervals: [{ start: 0, end: 30 }] }));
    expect(result).toEqual({ placement: null, skipReason: "NO_FREE_SPACE" });
  });
});

describe("enumerateFeasiblePlacements", () => {
  it("matches enumerateFeasiblePlacementsForLength at the activity's full duration", () => {
    const resolved = resolveActivity(activity("Work").rank(1).minutes(60).build(), dayFrame);
    const context = baseContext({ freeIntervals: [{ start: 0, end: 120 }] });
    expect(enumerateFeasiblePlacements(resolved, context)).toEqual(
      enumerateFeasiblePlacementsForLength(resolved, 60, context).map((r) => r.placement),
    );
  });
});

describe("evaluateCandidate — StrictWindowRule", () => {
  it.each([
    ["fully inside", 540, 600, true], // 09:00-10:00 inside 09:00-18:00
    ["touches both edges exactly", 540, 1080, true], // 09:00-18:00
    ["starts before the window", 500, 600, false],
    ["ends after the window", 1000, 1100, false],
  ])("%s", (_label, start, end, expectedFeasible) => {
    const resolved = resolveActivity(
      activity("Work")
        .rank(1)
        .minutes(end - start)
        .strict("09:00", "18:00")
        .build(),
      dayFrame,
    );
    expect(evaluateCandidate(resolved, start, end).feasible).toBe(expectedFeasible);
  });
});

// The table from SPEC.md Section 5.3: window 18:00-20:00 (1080-1200),
// duration 60, max_drift_minutes = 30.
describe("evaluateCandidate — FlexibleWindowRule drift (SPEC.md Section 5.3 table)", () => {
  it.each([
    ["fully inside", 1080, 1140, 0, true],
    ["15m early", 1065, 1125, 15, true],
    ["at drift limit", 1170, 1230, 30, true],
    ["over the limit", 1215, 1275, 60, false],
  ])("%s", (_label, start, end, expectedDrift, expectedFeasible) => {
    const resolved = resolveActivity(
      activity("Dinner").rank(1).minutes(60).flexible("18:00", "20:00", { drift: 30 }).build(),
      dayFrame,
    );
    const verdict = evaluateCandidate(resolved, start, end);
    expect(verdict.driftMinutes).toBe(expectedDrift);
    expect(verdict.feasible).toBe(expectedFeasible);
  });
});

describe("placeActivity — window rules", () => {
  it("skips with WINDOW_UNSATISFIABLE when a strict window can never be met", () => {
    const resolved = resolveActivity(
      activity("Work").rank(1).minutes(60).strict("09:00", "09:30").build(),
      dayFrame,
    );
    const result = placeActivity(resolved, baseContext());
    expect(result).toEqual({
      placement: null,
      skipReason: "WINDOW_UNSATISFIABLE",
    });
  });

  it("skips with DRIFT_EXCEEDED when the flexible window can never be met", () => {
    const resolved = resolveActivity(
      activity("Dinner").rank(1).minutes(120).flexible("18:00", "19:00", { drift: 10 }).build(),
      dayFrame,
    );
    const result = placeActivity(resolved, baseContext());
    expect(result).toEqual({ placement: null, skipReason: "DRIFT_EXCEEDED" });
  });

  it("prefers the zero-drift placement over an earlier, drifted one", () => {
    // Window 18:00-20:00 (1080-1200), duration 60. The earliest grid start
    // overall is 0, but it costs DRIFT * 1080; the window's own start costs 0.
    const resolved = resolveActivity(
      activity("Dinner").rank(1).minutes(60).flexible("18:00", "20:00", { drift: 1440 }).build(),
      dayFrame,
    );
    const result = placeActivity(resolved, baseContext({ weight: 1 }));
    expect(result.placement).toEqual({ start: 1080, end: 1140, nestedIn: null });
  });
});

describe("placeActivityWithFloor — ShrinkRule ladder", () => {
  it("is identical to placeActivity when the floor equals the full duration", () => {
    const resolved = resolveActivity(activity("Work").rank(1).minutes(60).build(), dayFrame);
    const result = placeActivityWithFloor(resolved, 60, baseContext());
    expect(result.placement).toEqual({ start: 0, end: 60, nestedIn: null });
    expect(result.scheduledMinutes).toBe(60);
  });

  it("prefers the full duration when it fits, even with a lower floor available", () => {
    const resolved = resolveActivity(activity("Work").rank(1).minutes(60).build(), dayFrame);
    const result = placeActivityWithFloor(resolved, 30, baseContext());
    expect(result.scheduledMinutes).toBe(60);
    expect(result.placement).toEqual({ start: 0, end: 60, nestedIn: null });
  });

  it("shrinks to the largest length that fits when the full duration cannot", () => {
    // Only a 45-minute free interval is available; duration 60, floor 30.
    const resolved = resolveActivity(activity("Work").rank(1).minutes(60).build(), dayFrame);
    const result = placeActivityWithFloor(
      resolved,
      30,
      baseContext({ freeIntervals: [{ start: 0, end: 45 }] }),
    );
    expect(result.placement).toEqual({ start: 0, end: 45, nestedIn: null });
    expect(result.scheduledMinutes).toBe(45);
  });

  it("skips when nothing fits even at the floor", () => {
    const resolved = resolveActivity(activity("Work").rank(1).minutes(60).build(), dayFrame);
    const result = placeActivityWithFloor(
      resolved,
      30,
      baseContext({ freeIntervals: [{ start: 0, end: 20 }] }),
    );
    expect(result.placement).toBeNull();
    expect(result.skipReason).toBe("NO_FREE_SPACE");
    expect(result.scheduledMinutes).toBe(0);
  });

  it("reports NO_FREE_SPACE for a plain (no window rule) activity blocked only by an unsatisfiable absolute exclusion", () => {
    // Raw grid starts exist (the floor fits fine inside the free interval),
    // but every one of them fails to contain an exclusion window far outside
    // it — the activity has no window rule of its own, so inferSkipReason
    // falls through both window checks to its plain NO_FREE_SPACE default.
    const resolved = resolveActivity(activity("Work").rank(1).minutes(30).build(), dayFrame);
    const result = placeActivityWithFloor(
      resolved,
      30,
      baseContext({
        freeIntervals: [{ start: 0, end: 100 }],
        absoluteExclusions: [{ start: 200, end: 300 }],
      }),
    );
    expect(result.placement).toBeNull();
    expect(result.skipReason).toBe("NO_FREE_SPACE");
  });
});
