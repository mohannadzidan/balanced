import type {
  Activity,
  ExclusionWindow,
  Rule,
  Weekday,
} from "@/app/brain/engine/types"

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
 * Fluent factory for test activities, per SPEC.md Section 16.2. Every test
 * states only the properties it cares about; everything else takes a
 * sensible default.
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

  id(id: string): this {
    this.activityId = id
    return this
  }

  rank(r: number): this {
    this.priorityRank = r
    return this
  }

  minutes(m: number): this {
    this.durationMinutes = m
    return this
  }

  days(...days: Weekday[]): this {
    this.allowedDays = days
    return this
  }

  disabled(): this {
    this.enabled = false
    return this
  }

  fixed(startWall: string, endWall: string): this {
    this.rules.push({ type: "fixed", source: "template", startWall, endWall })
    return this
  }

  strict(startWall: string, endWall: string): this {
    this.rules.push({
      type: "strictWindow",
      source: "template",
      startWall,
      endWall,
    })
    return this
  }

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

  mandatory(): this {
    this.rules.push({ type: "mandatory", source: "template" })
    return this
  }

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

  build(): Activity {
    if (this.priorityRank === null) {
      throw new Error(`fixture activity "${this.name}" is missing .rank(n)`)
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

export function activity(name: string): ActivityBuilder {
  return new ActivityBuilder(name)
}
