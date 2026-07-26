import type { Activity, ExclusionWindow, Rule, Weekday } from "./types"

const ALL_DAYS: readonly Weekday[] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
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
  private activityId: string
  private durationMinutes = 30
  private priorityRank: number | null = null
  private allowedDays: readonly Weekday[] = ALL_DAYS
  private enabled = true
  private rules: Rule[] = []

  constructor(private readonly name: string) {
    this.activityId = slugify(name)
  }

  /** Overrides the auto-generated (slugified) id. */
  id(id: string): this {
    this.activityId = id
    return this
  }

  /** Priority rank used for cost weighting and hard-set ordering (SPEC.md Section 4). Required. */
  rank(r: number): this {
    this.priorityRank = r
    return this
  }

  /** Full (unshrunk, unchunked) duration in minutes. Defaults to 30. */
  minutes(m: number): this {
    this.durationMinutes = m
    return this
  }

  /** Restricts which weekdays this activity is eligible on. Defaults to every day. */
  days(...days: Weekday[]): this {
    this.allowedDays = days
    return this
  }

  /** Marks the activity disabled — excluded from solving entirely. */
  disabled(): this {
    this.enabled = false
    return this
  }

  /** Adds a `FixedRule`: an immovable wall-clock span, may span midnight (SPEC.md Section 5.1). */
  fixed(startWall: string, endWall: string): this {
    this.rules.push({ type: "fixed", source: "template", startWall, endWall })
    return this
  }

  /** Adds a `StrictWindowRule`: must be placed entirely inside this window, no drift. */
  strict(startWall: string, endWall: string): this {
    this.rules.push({
      type: "strictWindow",
      source: "template",
      startWall,
      endWall,
    })
    return this
  }

  /** Adds a `FlexibleWindowRule`: preferred window, allowed to drift outside it by `opts.drift` minutes. */
  flexible(
    startWall: string,
    endWall: string,
    opts?: { drift?: number }
  ): this {
    this.rules.push({
      type: "flexibleWindow",
      source: "template",
      startWall,
      endWall,
      maxDriftMinutes: opts?.drift ?? 0,
    })
    return this
  }

  /** Adds a `MandatoryRule`: placed via the bounded-backtracking hard set instead of the greedy pass. */
  mandatory(): this {
    this.rules.push({ type: "mandatory", source: "template" })
    return this
  }

  /**
   * Adds a `ShrinkRule`: permits reducing the activity down to `opts.floor`
   * minutes and/or splitting it into chunks of at least `opts.minChunk`
   * minutes (up to `opts.maxChunks`) when the full duration can't fit
   * (SPEC.md Section 5.5). A chunked plan may also sum to less than the full
   * duration, as long as it still clears `opts.floor` (SPEC.md 14.6b).
   */
  shrink(opts: {
    floor: number
    chunking?: boolean
    minChunk?: number
    maxChunks?: number
  }): this {
    this.rules.push({
      type: "shrink",
      source: "template",
      minDurationMinutes: opts.floor,
      chunkingAllowed: opts.chunking ?? false,
      minChunkMinutes: opts.minChunk ?? opts.floor,
      maxChunks: opts.maxChunks ?? 3,
    })
    return this
  }

  /** Adds a `SequenceRule`: this activity must run immediately before/after `linkedActivityId`. */
  sequence(
    role: "pre" | "post",
    linkedActivityId: string,
    opts?: { maxGap?: number }
  ): this {
    this.rules.push({
      type: "sequence",
      source: "template",
      role,
      linkedActivityId,
      maxGapMinutes: opts?.maxGap ?? 0,
    })
    return this
  }

  /** Adds an `OverlapRule`: this activity may host guest activities nested inside it, within a time budget. */
  overlap(opts: {
    budget: number
    guests: readonly string[]
    exclusions?: readonly ExclusionWindow[]
  }): this {
    this.rules.push({
      type: "overlap",
      source: "template",
      budgetMinutes: opts.budget,
      allowedGuestIds: opts.guests,
      exclusionWindows: opts.exclusions ?? [],
    })
    return this
  }

  /** Builds the immutable `Activity` template. Throws if `.rank()` was never called. */
  build(): Activity {
    if (this.priorityRank === null) {
      throw new Error(`activity "${this.name}" is missing .rank(n)`)
    }
    return {
      id: this.activityId,
      name: this.name,
      durationMinutes: this.durationMinutes,
      priorityRank: this.priorityRank,
      allowedDays: this.allowedDays,
      enabled: this.enabled,
      rules: this.rules,
    }
  }
}

/** Starts a fluent `Activity` template builder. See `ActivityBuilder`. */
export function activity(name: string): ActivityBuilder {
  return new ActivityBuilder(name)
}
