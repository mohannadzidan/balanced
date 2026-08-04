import { describe, expect, it } from "vitest";

import { DEFAULT_COST_CONSTANTS } from "../src/engine/constants";
import type { PlacementContext } from "../src/engine/placement";
import { resolveActivity } from "../src/engine/resolve";
import { planChunks, placeWithElasticity } from "../src/engine/shrink";
import { resolveDayFrame } from "../src/engine/time";
import type { ElasticityRule, RepeatRule } from "../src/engine/types";
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

function elasticityRule(minTotal: number, minBlock: number): ElasticityRule {
  return {
    type: "elasticity",
    source: "template",
    minTotalMinutes: minTotal,
    minBlockMinutes: minBlock,
  };
}

function repeatRule(count: number, sharedBudget = true): RepeatRule {
  return {
    type: "repeat",
    source: "template",
    period: "day",
    count,
    sharedBudget,
    minSeparationMinutes: 0,
  };
}

describe("planChunks", () => {
  it("returns null when the repeat rule is not shared-budget", () => {
    const resolved = resolveActivity(activity("Deep Work").rank(1).minutes(120).build(), dayFrame);
    expect(
      planChunks(resolved, elasticityRule(60, 45), repeatRule(3, false), baseContext()),
    ).toBeNull();
  });

  it("splits across two free gaps to reach the full duration (SPEC.md 14.6)", () => {
    const resolved = resolveActivity(
      activity("Deep Work").rank(1).minutes(120).flexible("09:00", "17:00", { drift: 0 }).build(),
      dayFrame,
    );
    // Two free gaps: 09:00-10:00 (540-600) and 14:00-15:00 (840-900).
    const plan = planChunks(
      resolved,
      elasticityRule(60, 45),
      repeatRule(3),
      baseContext({
        freeIntervals: [
          { start: 540, end: 600 },
          { start: 840, end: 900 },
        ],
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.scheduledMinutes).toBe(120);
    expect(plan!.chunks).toHaveLength(2);
    expect(plan!.chunks.map((c) => c.end - c.start).sort((a, b) => a - b)).toEqual([60, 60]);
    // One extra chunk, zero shrink, zero drift: W * CHUNK * 1.
    expect(plan!.cost).toBe(C.CHUNK);
  });

  it("finds a valid split across unequal-sized regions instead of greedily stranding the smaller one (regression)", () => {
    // A naive "fill the largest region first, up to the full target" would
    // give the 90-minute region 90 minutes, leaving only 30 for the
    // 60-minute region — below the 45-minute floor, wrongly reporting no
    // plan exists even though 60 + 60 (or any 45..90/30..60 split) legally
    // reaches the 120-minute target.
    const resolved = resolveActivity(
      activity("Deep Work").rank(1).minutes(120).flexible("09:00", "17:30", { drift: 0 }).build(),
      dayFrame,
    );
    const plan = planChunks(
      resolved,
      elasticityRule(60, 45),
      repeatRule(3),
      baseContext({
        freeIntervals: [
          { start: 540, end: 600 }, // 60-minute region
          { start: 840, end: 930 }, // 90-minute region
        ],
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.scheduledMinutes).toBe(120);
    expect(plan!.chunks).toHaveLength(2);
    for (const chunk of plan!.chunks) {
      expect(chunk.end - chunk.start).toBeGreaterThanOrEqual(45);
    }
  });

  it("returns null when the free regions cannot reach the target even chunked", () => {
    const resolved = resolveActivity(activity("Deep Work").rank(1).minutes(120).build(), dayFrame);
    const plan = planChunks(
      resolved,
      elasticityRule(60, 45),
      repeatRule(3),
      baseContext({ freeIntervals: [{ start: 0, end: 50 }] }),
    );
    expect(plan).toBeNull();
  });

  it("returns null when every free region is individually smaller than the minimum chunk", () => {
    const resolved = resolveActivity(activity("Deep Work").rank(1).minutes(120).build(), dayFrame);
    // 10 minutes total, all in one region — never even reaches one chunk.
    const plan = planChunks(
      resolved,
      elasticityRule(60, 45),
      repeatRule(3),
      baseContext({ freeIntervals: [{ start: 0, end: 10 }] }),
    );
    expect(plan).toBeNull();
  });

  it("returns null when a region's grid-aligned starts are entirely before the freeze boundary", () => {
    const resolved = resolveActivity(activity("Deep Work").rank(1).minutes(60).build(), dayFrame);
    // Large enough on paper (100m, well over the 30m minimum chunk), but
    // every grid-aligned start inside it is frozen out.
    const plan = planChunks(
      resolved,
      elasticityRule(30, 30),
      repeatRule(2),
      baseContext({
        freeIntervals: [{ start: 0, end: 100 }],
        freezeBoundary: 150,
      }),
    );
    expect(plan).toBeNull();
  });

  it("skips a region the reservation for later regions can't leave a full minimum chunk in", () => {
    // Three equal 40m regions, target 90: with all three selected (k=3),
    // reserving 40m for each of the two regions still to come caps the
    // first one at only 10m — below the 40m minimum — so it's skipped
    // entirely rather than taking a partial share (an internal detail of
    // the k=3 search; k=2 ties it on cost and wins for being tried first).
    const resolved = resolveActivity(
      activity("Deep Work").rank(1).minutes(90).flexible("09:00", "17:00", { drift: 0 }).build(),
      dayFrame,
    );
    const plan = planChunks(
      resolved,
      elasticityRule(80, 40),
      repeatRule(3),
      baseContext({
        freeIntervals: [
          { start: 540, end: 580 }, // 40m
          { start: 700, end: 740 }, // 40m
          { start: 800, end: 840 }, // 40m
        ],
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.scheduledMinutes).toBe(80);
    expect(plan!.chunks).toHaveLength(2);
    expect(plan!.chunks.map((c) => [c.start, c.end])).toEqual([
      [540, 580],
      [700, 740],
    ]);
  });

  it("stops filling once the target is met, even with unused regions still selected (degenerate zero-minute minimum chunk)", () => {
    // Realistic elasticity configs (minBlockMinutes > 0) can never hit this:
    // the reservation formula (`remaining - minChunk * regionsAfter`)
    // provably can't reach exactly zero before the last selected region
    // unless minChunk is 0. Exercised directly here as a degenerate-input
    // boundary check on fillChunks' own loop, not a realistic activity.
    const resolved = resolveActivity(activity("Deep Work").rank(1).minutes(20).build(), dayFrame);
    const plan = planChunks(
      resolved,
      elasticityRule(20, 0),
      repeatRule(3),
      baseContext({
        freeIntervals: [
          { start: 0, end: 20 },
          { start: 100, end: 120 },
          { start: 200, end: 220 },
        ],
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.scheduledMinutes).toBe(20);
    expect(plan!.chunks).toHaveLength(1);
  });

  it("accepts a chunked plan that only partially completes the activity, as long as it still clears the elasticity floor (SPEC.md 5.5 / 14.6b / edge case 23)", () => {
    const resolved = resolveActivity(
      activity("Deep Work").rank(1).minutes(120).flexible("09:00", "17:00", { drift: 0 }).build(),
      dayFrame,
    );
    // Two 50-minute gaps: 100 minutes total, short of the full 120-minute
    // duration but past the 90-minute floor.
    const plan = planChunks(
      resolved,
      elasticityRule(90, 45),
      repeatRule(3),
      baseContext({
        freeIntervals: [
          { start: 540, end: 590 },
          { start: 780, end: 830 },
        ],
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.scheduledMinutes).toBe(100);
    expect(plan!.chunks).toHaveLength(2);
    for (const chunk of plan!.chunks) {
      expect(chunk.end - chunk.start).toBeGreaterThanOrEqual(45);
    }
  });

  it("still returns null when even the best partial chunked total falls short of the elasticity floor", () => {
    const resolved = resolveActivity(
      activity("Deep Work").rank(1).minutes(120).flexible("09:00", "17:00", { drift: 0 }).build(),
      dayFrame,
    );
    const plan = planChunks(
      resolved,
      elasticityRule(110, 45), // the same two gaps only total 100
      repeatRule(3),
      baseContext({
        freeIntervals: [
          { start: 540, end: 590 },
          { start: 780, end: 830 },
        ],
      }),
    );
    expect(plan).toBeNull();
  });
});

describe("placeWithElasticity", () => {
  it("prefers chunking over a single shrunk block when it is cheaper (SPEC.md 14.6)", () => {
    const resolved = resolveActivity(
      activity("Deep Work").rank(1).minutes(120).flexible("09:00", "17:00", { drift: 0 }).build(),
      dayFrame,
    );
    const outcome = placeWithElasticity(
      resolved,
      elasticityRule(60, 45),
      repeatRule(3),
      baseContext({
        freeIntervals: [
          { start: 540, end: 600 },
          { start: 840, end: 900 },
        ],
      }),
    );
    expect(outcome.placement).toBeNull();
    expect(outcome.chunks).toHaveLength(2);
    expect(outcome.scheduledMinutes).toBe(120);
  });

  it("falls back to a single block when there is no RepeatRule", () => {
    const resolved = resolveActivity(activity("Gym").rank(1).minutes(60).build(), dayFrame);
    const outcome = placeWithElasticity(resolved, elasticityRule(30, 30), null, baseContext());
    expect(outcome.chunks).toBeNull();
    expect(outcome.placement).toEqual({ start: 0, end: 60, nestedIn: null });
  });

  it("behaves like an unshrinkable activity when there is no ElasticityRule or RepeatRule", () => {
    const resolved = resolveActivity(activity("Gym").rank(1).minutes(60).build(), dayFrame);
    const outcome = placeWithElasticity(
      resolved,
      null,
      null,
      baseContext({ freeIntervals: [{ start: 0, end: 30 }] }),
    );
    expect(outcome.placement).toBeNull();
    expect(outcome.chunks).toBeNull();
    expect(outcome.skipReason).toBe("NO_FREE_SPACE");
  });
});
