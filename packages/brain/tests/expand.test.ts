import { describe, it, expect } from "vitest";
import { expand } from "../src/engine/expand";
import type { Activity, Rule, RepeatRule, Weekday, WindowRule } from "../src/engine/types";
import { resolveFrame } from "../src/engine/time";

function act(id: string, duration: number, rank: number, rules: readonly Rule[] = []): Activity {
  return {
    id,
    name: id,
    durationMinutes: duration,
    priorityRank: rank,
    enabled: true,
    rules,
    requiredCount: 0,
  };
}

function win(start: string, end: string, drift: number, days: readonly Weekday[]): WindowRule {
  return {
    type: "window",
    source: "template",
    days,
    startWall: start,
    endWall: end,
    maxDriftMinutes: drift,
  };
}

function rep(period: RepeatRule["period"], count: number): RepeatRule {
  return {
    type: "repeat",
    source: "template",
    period,
    count,
    sharedBudget: false,
    minSeparationMinutes: 0,
  };
}

describe("src/engine/expand", () => {
  const frame = resolveFrame("2026-07-29", 5, "UTC"); // Wed 2026-07-29 .. Sun 2026-08-02

  it("Mon/Wed/Fri bucketing with period: 'day'", () => {
    const catalog = [
      act("Gym", 60, 1, [win("09:00", "10:00", 0, ["MON", "WED", "FRI"]), rep("day", 1)]),
    ];

    const occs = expand(catalog, frame);

    expect(occs).toHaveLength(2); // frame only spans Wed 07-29 .. Sun 08-02: WED and FRI
    const bucketKeys = occs.map((o) => o.bucketKey).sort();
    expect(bucketKeys).toEqual(["2026-07-29", "2026-07-31"]);

    for (const occ of occs) {
      expect(occ.activity.id).toBe("Gym");
      expect(occ.index).toBe(1);
      expect(occ.required).toBe(false);
      expect(occ.windows).toHaveLength(1);
      expect(occ.windows[0].maxDriftMinutes).toBe(0);
      expect(occ.id).toBe(`Gym@${occ.bucketKey}#1`);
      expect(occ.siblingIds).toEqual([]);
    }
  });

  it("empty bucket yields nothing (§5.2)", () => {
    const catalog = [act("WeekendOnly", 60, 1, [win("09:00", "10:00", 0, ["SAT"]), rep("day", 1)])];

    // Frame is Wed-Sun; Saturday (08-01) is eligible, so one occurrence — but
    // an activity confined to a weekday absent from the frame gets none.
    const noSaturdayFrame = resolveFrame("2026-07-27", 2, "UTC"); // Mon, Tue only
    const occs = expand(catalog, noSaturdayFrame);

    expect(occs).toHaveLength(0);
  });

  it("determinism and sort order (§5.3)", () => {
    const catalog = [
      act("LowRank", 60, 2, [win("09:00", "10:00", 0, ["WED"]), rep("day", 1)]),
      act("HighRank", 60, 1, [win("09:00", "10:00", 0, ["WED"]), rep("day", 1)]),
      act("SameRank", 60, 1, [win("09:00", "10:00", 0, ["WED"]), rep("day", 1)]),
    ];

    const occs = expand(catalog, frame);

    expect(occs).toHaveLength(3);
    // Sort is by (priorityRank, bucketKey, index); ties (same rank, same
    // bucket, same index) fall back to catalog order via a stable sort.
    const ids = occs.map((o) => o.activity.id);
    expect(ids).toEqual(["HighRank", "SameRank", "LowRank"]);
  });

  it("handles count > 1 (siblingIds populated within the bucket)", () => {
    const catalog = [act("Gym", 60, 1, [win("09:00", "10:00", 0, ["WED"]), rep("day", 3)])];

    const occs = expand(catalog, frame);

    expect(occs).toHaveLength(3);
    for (const occ of occs) {
      expect(occ.bucketKey).toBe("2026-07-29");
      expect(occ.windows).toHaveLength(1);
      expect(occ.siblingIds).toHaveLength(2);
      expect(occ.siblingIds).not.toContain(occ.id);
    }
    expect(occs.map((o) => o.index)).toEqual([1, 2, 3]);
  });

  it("requiredCount marks the first N occurrences in a bucket as required", () => {
    const catalog = [
      {
        ...act("Gym", 60, 1, [win("09:00", "10:00", 0, ["WED"]), rep("day", 3)]),
        requiredCount: 2,
      },
    ];

    const occs = expand(catalog, frame);

    expect(occs.map((o) => o.required)).toEqual([true, true, false]);
  });

  it("a chunking RepeatRule (sharedBudget: true) is ignored for bucketing and passed through unchanged (§5.4)", () => {
    const chunk: RepeatRule = {
      type: "repeat",
      source: "template",
      period: "day",
      count: 3,
      sharedBudget: true,
      minSeparationMinutes: 0,
    };
    const recurrence = rep("day", 1);
    const catalog = [
      act("Gym", 60, 1, [win("09:00", "10:00", 0, ["WED", "FRI"]), chunk, recurrence]),
    ];

    const occs = expand(catalog, frame);

    // Recurrence (sharedBudget: false) drives bucketing: one occurrence per
    // eligible day. If the chunking rule (count: 3) were wrongly picked up
    // by bucketing instead, this would be 6 occurrences, 3 per day.
    expect(occs.map((o) => o.bucketKey)).toEqual(["2026-07-29", "2026-07-31"]);
    // The chunking rule survives untouched on each occurrence's activity, for
    // Drop 1's existing per-occurrence shrink/chunk machinery downstream.
    for (const occ of occs) {
      expect(occ.activity.rules).toContainEqual(chunk);
    }
  });

  it("period: 'week' buckets by ISO week (§5.1)", () => {
    const catalog = [
      act("Weekly", 60, 1, [
        win("09:00", "10:00", 0, ["WED", "THU", "FRI", "SAT", "SUN"]),
        rep("week", 1),
      ]),
    ];

    const occs = expand(catalog, frame);

    // All 5 frame days fall in ISO week 2026-W31 — one shared bucket, one
    // occurrence (count: 1), whose window spans every eligible day merged.
    expect(occs).toHaveLength(1);
    expect(occs[0].bucketKey).toBe("2026-W31");
  });

  it("period: 'month' buckets by calendar month, split across a boundary", () => {
    const catalog = [
      act("Monthly", 60, 1, [
        win("09:00", "10:00", 0, ["WED", "THU", "FRI", "SAT", "SUN"]),
        rep("month", 1),
      ]),
    ];

    const occs = expand(catalog, frame);

    // Frame spans 2026-07-29..2026-08-02: two calendar months, two buckets,
    // each producing one occurrence (count: 1 per bucket).
    expect(occs).toHaveLength(2);
    expect(occs.map((o) => o.bucketKey).sort()).toEqual(["2026-07", "2026-08"]);
  });

  it("period: 'frame' produces exactly one bucket for the whole frame", () => {
    const catalog = [
      act("OnceEver", 60, 1, [
        win("09:00", "10:00", 0, ["WED", "THU", "FRI", "SAT", "SUN"]),
        rep("frame", 1),
      ]),
    ];

    const occs = expand(catalog, frame);

    expect(occs).toHaveLength(1);
    expect(occs[0].bucketKey).toBe("frame");
  });

  it("an activity with no RepeatRule defaults to period: day, count: 1 (SPEC-v2.1 §2's equivalence property)", () => {
    // Matches N chained 1-day solves: one occurrence per eligible day, not
    // one for the whole multi-day frame.
    const catalog = [act("Plain", 60, 1, [win("09:00", "10:00", 0, ["WED", "FRI"])])];

    const occs = expand(catalog, frame);

    expect(occs.map((o) => o.bucketKey)).toEqual(["2026-07-29", "2026-07-31"]);
    expect(occs.every((o) => o.index === 1)).toBe(true);
  });

  it("an activity with no WindowRule at all is unconstrained: one occurrence per day, each confined to its own bucket", () => {
    // §3.2: no WindowRule means an implicit window covering every day in
    // full, not "no eligible windows anywhere" — resolveWindows() correctly
    // returns [] for this case, but that must not read as "ineligible" when
    // bucketing, or every FixedRule/unwindowed activity would silently
    // vanish from expand()'s output the moment it's wired into solve(). And
    // "every day in full" must be per-bucket: a genuinely empty windows list
    // would leave nothing stopping every day's occurrence from all competing
    // for the same day's time instead of each being confined to its own.
    const catalog = [act("Fixed", 60, 1, [])];

    const occs = expand(catalog, frame);

    expect(occs).toHaveLength(5); // frame is Wed 07-29 .. Sun 08-02: all 5 days
    const dates = ["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"];
    expect(occs.map((o) => o.bucketKey)).toEqual(dates);
    occs.forEach((occ, i) => {
      expect(occ.index).toBe(1);
      expect(occ.windows).toHaveLength(1);
      expect(occ.windows[0].maxDriftMinutes).toBe(0);
      // Confined to this occurrence's own bucket, not the whole frame.
      const day = frame.days[i];
      expect(occ.windows[0].start).toBe(day.startOffset);
      expect(occ.windows[0].end).toBe(day.startOffset + day.lengthMinutes);
    });
  });

  it("a spanning window belongs only to the day it starts on (period: 'day')", () => {
    // Sleep 23:00->07:00 on MON only. Its resolved window's `end` legitimately
    // extends into Tuesday's span — a naive span-overlap bucket intersection
    // would hand that same window to both Monday's and Tuesday's buckets,
    // producing a phantom second occurrence Tuesday was never eligible for.
    const catalog = [act("Sleep", 480, 1, [win("23:00", "07:00", 0, ["MON"]), rep("day", 1)])];
    const monFrame = resolveFrame("2026-07-27", 3, "UTC"); // Mon, Tue, Wed

    const occs = expand(catalog, monFrame);

    expect(occs).toHaveLength(1);
    expect(occs[0].bucketKey).toBe("2026-07-27");
  });

  it("quotas suppress already-placed occurrences within a bucket", () => {
    const catalog = [act("Gym", 60, 1, [win("09:00", "10:00", 0, ["WED"]), rep("day", 3)])];
    const quotas = {
      placed: new Map([["Gym", new Map([["2026-07-29", 2]])]]),
    };

    const occs = expand(catalog, frame, quotas);

    expect(occs).toHaveLength(1);
    expect(occs[0].index).toBe(1);
  });
});
