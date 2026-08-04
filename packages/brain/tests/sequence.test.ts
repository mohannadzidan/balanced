import { describe, expect, it } from "vitest";

import { resolveActivity } from "../src/engine/resolve";
import {
  findDependentPlacement,
  isDependent,
  placeSequenceChain,
  sequenceRuleOf,
} from "../src/engine/sequence";
import { resolveDayFrame } from "../src/engine/time";
import type { Activity, SequenceRule } from "../src/engine/types";
import { activity } from "./support/fixtures";

const dayFrame = resolveDayFrame("2024-06-17", "UTC");
const resolve = (a: Activity) => resolveActivity(a, dayFrame);

describe("sequenceRuleOf / isDependent", () => {
  it("finds the sequence rule on an activity that has one", () => {
    const a = activity("Commute").rank(1).minutes(30).sequence("pre", "work").build();
    expect(sequenceRuleOf(a)?.linkedActivityId).toBe("work");
    expect(isDependent(a)).toBe(true);
  });

  it("is undefined/false for an activity without one", () => {
    const a = activity("Work").rank(1).minutes(60).build();
    expect(sequenceRuleOf(a)).toBeUndefined();
    expect(isDependent(a)).toBe(false);
  });
});

describe("findDependentPlacement", () => {
  const free = [{ start: 0, end: 1440 }];

  it("places a pre-dependent immediately before its host at zero gap", () => {
    const commute = activity("Commute").rank(1).minutes(30).build();
    const rule: SequenceRule = {
      type: "sequence",
      source: "template",
      role: "pre",
      linkedActivityId: "work",
      maxGapMinutes: 15,
    };
    const found = findDependentPlacement(
      resolve(commute),
      rule,
      { start: 540, end: 600 },
      free,
      0,
      1440,
      5,
    );
    expect(found).toEqual({
      placement: { start: 510, end: 540, nestedIn: null },
      gapMinutes: 0,
    });
  });

  it("places a post-dependent immediately after its host at zero gap", () => {
    const commute = activity("Commute").rank(1).minutes(30).build();
    const rule: SequenceRule = {
      type: "sequence",
      source: "template",
      role: "post",
      linkedActivityId: "work",
      maxGapMinutes: 15,
    };
    const found = findDependentPlacement(
      resolve(commute),
      rule,
      { start: 540, end: 600 },
      free,
      0,
      1440,
      5,
    );
    expect(found).toEqual({
      placement: { start: 600, end: 630, nestedIn: null },
      gapMinutes: 0,
    });
  });

  it("widens the gap to find free space, up to max_gap_minutes", () => {
    // Host ends at 600; [600, 610) is occupied, so Commute (post, 30m) can
    // only start at 610 — a 10 minute gap.
    const commute = activity("Commute").rank(1).minutes(30).build();
    const rule: SequenceRule = {
      type: "sequence",
      source: "template",
      role: "post",
      linkedActivityId: "work",
      maxGapMinutes: 15,
    };
    const freeWithGap = [
      { start: 0, end: 600 },
      { start: 610, end: 1440 },
    ];
    const found = findDependentPlacement(
      resolve(commute),
      rule,
      { start: 540, end: 600 },
      freeWithGap,
      0,
      1440,
      5,
    );
    expect(found).toEqual({
      placement: { start: 610, end: 640, nestedIn: null },
      gapMinutes: 10,
    });
  });

  it("returns null when no legal gap exists within max_gap_minutes", () => {
    const commute = activity("Commute").rank(1).minutes(30).build();
    const rule: SequenceRule = {
      type: "sequence",
      source: "template",
      role: "post",
      linkedActivityId: "work",
      maxGapMinutes: 5,
    };
    const freeWithGap = [
      { start: 0, end: 600 },
      { start: 610, end: 1440 },
    ];
    const found = findDependentPlacement(
      resolve(commute),
      rule,
      { start: 540, end: 600 },
      freeWithGap,
      0,
      1440,
      5,
    );
    expect(found).toBeNull();
  });

  it("skips a candidate gap that starts before the freeze boundary, and widens until one clears it", () => {
    // Post dependent: g=0 would start exactly at the host's end (600), which
    // is still frozen; g=5 (605) clears the freeze boundary.
    const commute = activity("Commute").rank(1).minutes(30).build();
    const rule: SequenceRule = {
      type: "sequence",
      source: "template",
      role: "post",
      linkedActivityId: "work",
      maxGapMinutes: 15,
    };
    const found = findDependentPlacement(
      resolve(commute),
      rule,
      { start: 540, end: 600 },
      free,
      602,
      1440,
      5,
    );
    expect(found).toEqual({
      placement: { start: 605, end: 635, nestedIn: null },
      gapMinutes: 5,
    });
  });

  it("returns null when every candidate gap would spill past the end of the day", () => {
    const commute = activity("Commute").rank(1).minutes(30).build();
    const rule: SequenceRule = {
      type: "sequence",
      source: "template",
      role: "post",
      linkedActivityId: "work",
      maxGapMinutes: 15,
    };
    const found = findDependentPlacement(
      resolve(commute),
      rule,
      { start: 1400, end: 1430 },
      free,
      0,
      1440,
      5,
    );
    expect(found).toBeNull();
  });

  it("respects the dependent's own window rules", () => {
    // Post dependent wants 600-630, but its own strict window is 06:00-10:00
    // (360-600), so the zero-gap slot is infeasible and there is no other.
    const commute = activity("Commute").rank(1).minutes(30).strict("06:00", "10:00").build();
    const rule: SequenceRule = {
      type: "sequence",
      source: "template",
      role: "post",
      linkedActivityId: "work",
      maxGapMinutes: 15,
    };
    const found = findDependentPlacement(
      resolve(commute),
      rule,
      { start: 540, end: 600 },
      free,
      0,
      1440,
      5,
    );
    expect(found).toBeNull();
  });
});

describe("placeSequenceChain", () => {
  const ctx = { freezeBoundary: 0, lengthMinutes: 1440, grid: 5, resolve };

  it("places a dependent adjacent to its placed host", () => {
    const commute = activity("Commute").rank(1).minutes(30).sequence("pre", "work").build();
    const hostResolutions = new Map([["work", { start: 540, end: 600, nestedIn: null }]] as const);
    const outcome = placeSequenceChain([commute], hostResolutions, [], ctx);
    expect(outcome.placements.get("commute")).toEqual({
      start: 510,
      end: 540,
      nestedIn: null,
    });
    expect(outcome.skipped.size).toBe(0);
  });

  it("skips a dependent with HOST_SKIPPED at zero cost when the host is skipped", () => {
    const commute = activity("Commute").rank(1).minutes(30).sequence("pre", "work").build();
    const hostResolutions = new Map([["work", "SKIPPED" as const]]);
    const outcome = placeSequenceChain([commute], hostResolutions, [], ctx);
    expect(outcome.placements.size).toBe(0);
    expect(outcome.skipped.get("commute")).toBe("HOST_SKIPPED");
  });

  it("resolves a chain (A pre B, B pre C) across rounds", () => {
    const b = activity("B").rank(1).minutes(20).sequence("pre", "c").build();
    const a = activity("A").rank(2).minutes(10).sequence("pre", "b").build();
    const hostResolutions = new Map([["c", { start: 600, end: 660, nestedIn: null }]] as const);
    // Intentionally out of dependency order — A depends on B, which is
    // resolved in the same pass — to prove round-based resolution works.
    const outcome = placeSequenceChain([a, b], hostResolutions, [], ctx);
    expect(outcome.placements.get("b")).toEqual({
      start: 580,
      end: 600,
      nestedIn: null,
    });
    expect(outcome.placements.get("a")).toEqual({
      start: 570,
      end: 580,
      nestedIn: null,
    });
  });

  it("skips with NO_FREE_SPACE when the host is placed but no adjacent room exists", () => {
    const commute = activity("Commute")
      .rank(1)
      .minutes(30)
      .sequence("pre", "work", { maxGap: 0 })
      .build();
    const hostResolutions = new Map([["work", { start: 540, end: 600, nestedIn: null }]] as const);
    // Occupy the only room a zero-gap pre-placement could use.
    const baseOccupied = [{ start: 520, end: 540 }];
    const outcome = placeSequenceChain([commute], hostResolutions, baseOccupied, ctx);
    expect(outcome.placements.size).toBe(0);
    expect(outcome.skipped.get("commute")).toBe("NO_FREE_SPACE");
  });

  it("defensively skips a mutual cycle of dependents whose hosts never resolve", () => {
    // A pre B, B pre A: neither is ever a key in hostResolutions, so neither
    // round makes progress. validateCatalog's SEQUENCE_CYCLE check should
    // normally prevent this from reaching solve() at all — this exercises
    // the function's own fallback directly.
    const a = activity("A").rank(1).minutes(10).sequence("pre", "b").build();
    const b = activity("B").rank(2).minutes(10).sequence("pre", "a").build();
    const outcome = placeSequenceChain([a, b], new Map(), [], ctx);
    expect(outcome.placements.size).toBe(0);
    expect(outcome.skipped.get("a")).toBe("NO_FREE_SPACE");
    expect(outcome.skipped.get("b")).toBe("NO_FREE_SPACE");
  });
});
