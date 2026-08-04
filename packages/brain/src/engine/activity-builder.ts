import type { Activity, ExclusionWindow, RepeatRule, Rule, Weekday } from "./types";

const ALL_DAYS: readonly Weekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function isFullWeek(days: readonly Weekday[]): boolean {
  return ALL_DAYS.every((d) => days.includes(d)) && days.length === ALL_DAYS.length;
}

interface WindowSpec {
  readonly startWall: string;
  readonly endWall: string;
  readonly maxDriftMinutes: number;
  readonly days?: readonly Weekday[];
}

/**
 * Fluent builder for `Activity` templates — the recommended way to construct
 * catalog entries for `solve()` without hand-assembling the `Rule` union
 * yourself. Every method appends one rule (SPEC.md Section 5); combine only
 * the ones a given activity needs; state just the properties you care about
 * and let the rest take a sensible default.
 *
 * @example
 * ```ts
 * const gym = activity("Gym")
 *   .rank(2)
 *   .minutes(60)
 *   .flexible("18:00", "20:00", { drift: 15 })
 *   .shrink({ floor: 30 })
 *   .build()
 * ```
 */
export class ActivityBuilder {
  private activityId: string;
  private durationMinutes = 30;
  private priorityRank: number | null = null;
  private allowedDays: readonly Weekday[] = ALL_DAYS;
  private enabled = true;
  private rules: Rule[] = [];
  private windowSpecs: WindowSpec[] = [];
  private requiredCount = 0;

  constructor(private readonly name: string) {
    this.activityId = slugify(name);
  }

  /** Overrides the auto-generated (slugified) id. */
  id(id: string): this {
    this.activityId = id;
    return this;
  }

  /** Priority rank used for cost weighting and hard-set ordering (SPEC.md Section 4). Required. */
  rank(r: number): this {
    this.priorityRank = r;
    return this;
  }

  /** Full (unshrunk, unchunked) duration in minutes. Defaults to 30. */
  minutes(m: number): this {
    this.durationMinutes = m;
    return this;
  }

  /**
   * Restricts which weekdays this activity is eligible on — sets `days` on
   * every WindowRule the activity ends up with (SPEC-v2.md Section 10.1),
   * including an implicit one synthesized at `.build()` if no `.strict()`/
   * `.flexible()`/`.window()` call created one. Defaults to every day.
   */
  days(...days: Weekday[]): this {
    this.allowedDays = days;
    return this;
  }

  /** Marks the activity disabled — excluded from solving entirely. */
  disabled(): this {
    this.enabled = false;
    return this;
  }

  /** Adds a `FixedRule`: an immovable wall-clock span, may span midnight (SPEC.md Section 5.1). */
  fixed(startWall: string, endWall: string): this {
    this.rules.push({ type: "fixed", source: "template", startWall, endWall });
    return this;
  }

  /** Adds a `WindowRule` with zero drift: must be placed entirely inside this window. */
  strict(startWall: string, endWall: string): this {
    this.windowSpecs.push({ startWall, endWall, maxDriftMinutes: 0 });
    return this;
  }

  /** Adds a `WindowRule`: preferred window, allowed to drift outside it by `opts.drift` minutes. */
  flexible(startWall: string, endWall: string, opts?: { drift?: number }): this {
    this.windowSpecs.push({
      startWall,
      endWall,
      maxDriftMinutes: opts?.drift ?? 0,
    });
    return this;
  }

  /**
   * Adds a `WindowRule` directly (SPEC-v2.md Section 4.1) — repeatable,
   * unlike `.strict()`/`.flexible()`; an activity's eligible region is the
   * union of its windows, and drift is the minimum over windows. `opts.days`
   * overrides this specific window's days independently of `.days()`.
   */
  window(
    startWall: string,
    endWall: string,
    opts?: { drift?: number; days?: readonly Weekday[] },
  ): this {
    this.windowSpecs.push({
      startWall,
      endWall,
      maxDriftMinutes: opts?.drift ?? 0,
      days: opts?.days,
    });
    return this;
  }

  /** Sets `requiredCount` to 1: placed via the bounded-backtracking hard set instead of the greedy pass. */
  mandatory(): this {
    this.requiredCount = 1;
    return this;
  }

  /**
   * Sets `Activity.requiredCount` directly (SPEC-v2.md Section 5) — `.mandatory()`
   * is sugar for `.required(1)`. Drop 1 permits only 0 or 1.
   */
  required(n: number): this {
    this.requiredCount = n;
    return this;
  }

  /**
   * Adds an `ElasticityRule` and, when `opts.chunking` is set, a
   * shared-budget `RepeatRule` (SPEC-v2.md Section 10.1 — sugar over the
   * merged rule vocabulary): permits reducing the activity down to
   * `opts.floor` minutes and/or splitting it into chunks of at least
   * `opts.minChunk` minutes (up to `opts.maxChunks`) when the full duration
   * can't fit (SPEC.md Section 5.5). A chunked plan may also sum to less
   * than the full duration, as long as it still clears `opts.floor`
   * (SPEC.md 14.6b).
   */
  shrink(opts: { floor: number; chunking?: boolean; minChunk?: number; maxChunks?: number }): this {
    this.rules.push({
      type: "elasticity",
      source: "template",
      minTotalMinutes: opts.floor,
      minBlockMinutes: opts.minChunk ?? opts.floor,
    });
    if (opts.chunking) {
      this.rules.push({
        type: "repeat",
        source: "template",
        period: "day",
        count: opts.maxChunks ?? 3,
        sharedBudget: true,
        minSeparationMinutes: 0,
      });
    }
    return this;
  }

  /** Adds an `ElasticityRule` directly (SPEC-v2.md Section 4.3). */
  elastic(opts: { minTotal: number; minBlock?: number }): this {
    this.rules.push({
      type: "elasticity",
      source: "template",
      minTotalMinutes: opts.minTotal,
      minBlockMinutes: opts.minBlock ?? opts.minTotal,
    });
    return this;
  }

  /**
   * Adds a `RepeatRule` directly (SPEC-v2.md Section 4.2 / SPEC-v2.1 §5.4).
   * Defaults to the chunking direction (`sharedBudget: true`, `period:
   * "day"`) for backward compatibility; pass `sharedBudget: false` for the
   * recurrence direction (Activity -> Occurrences, SPEC-v2.1 §5) with any
   * `period`. `minSeparationMinutes` is not yet wired into placement
   * (SPEC-v2.1 §6.1, step 4).
   */
  repeat(opts: {
    count: number;
    period?: RepeatRule["period"];
    sharedBudget?: boolean;
    minSeparationMinutes?: number;
  }): this {
    this.rules.push({
      type: "repeat",
      source: "template",
      period: opts.period ?? "day",
      count: opts.count,
      sharedBudget: opts.sharedBudget ?? true,
      minSeparationMinutes: opts.minSeparationMinutes ?? 0,
    });
    return this;
  }

  /** Adds a `SequenceRule`: this activity must run immediately before/after `linkedActivityId`. */
  sequence(role: "pre" | "post", linkedActivityId: string, opts?: { maxGap?: number }): this {
    this.rules.push({
      type: "sequence",
      source: "template",
      role,
      linkedActivityId,
      maxGapMinutes: opts?.maxGap ?? 0,
    });
    return this;
  }

  /** Adds an `OverlapRule`: this activity may host guest activities nested inside it, within a time budget. */
  overlap(opts: {
    budget: number;
    guests: readonly string[];
    exclusions?: readonly ExclusionWindow[];
  }): this {
    this.rules.push({
      type: "overlap",
      source: "template",
      budgetMinutes: opts.budget,
      allowedGuestIds: opts.guests,
      exclusionWindows: opts.exclusions ?? [],
    });
    return this;
  }

  /** Builds the immutable `Activity` template. Throws if `.rank()` was never called. */
  build(): Activity {
    if (this.priorityRank === null) {
      throw new Error(`activity "${this.name}" is missing .rank(n)`);
    }

    const windowRules: Rule[] = this.windowSpecs.map((spec) => ({
      type: "window",
      source: "template",
      days: spec.days ?? this.allowedDays,
      startWall: spec.startWall,
      endWall: spec.endWall,
      maxDriftMinutes: spec.maxDriftMinutes,
    }));

    // No explicit window was ever created, but `.days()` restricted
    // eligibility away from the default — synthesize a whole-day, zero-drift
    // WindowRule (00:00-24:00, DST-correct via resolveWallClock) purely to
    // carry that restriction, so day-eligibility (SPEC-v2.md Section 4.1) is
    // expressible without a real time-of-day constraint.
    if (windowRules.length === 0 && !isFullWeek(this.allowedDays)) {
      windowRules.push({
        type: "window",
        source: "template",
        days: this.allowedDays,
        startWall: "00:00",
        endWall: "24:00",
        maxDriftMinutes: 0,
      });
    }

    return {
      id: this.activityId,
      name: this.name,
      durationMinutes: this.durationMinutes,
      priorityRank: this.priorityRank,
      enabled: this.enabled,
      rules: [...this.rules, ...windowRules],
      requiredCount: this.requiredCount,
    };
  }
}

/** Starts a fluent `Activity` template builder. See `ActivityBuilder`. */
export function activity(name: string): ActivityBuilder {
  return new ActivityBuilder(name);
}
