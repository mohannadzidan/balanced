// Domain types for the Dynamic Day Scheduler engine.
// See app/brain/SPEC.md for the full specification these types implement.

export type Weekday = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT"

// SPEC-v2.md Section 3: one entry in Frame.days. Drop 1 always has exactly one.
export interface Day {
  readonly index: number // 0-based
  readonly date: string // YYYY-MM-DD
  readonly weekday: Weekday
  readonly startOffset: number // minutes from frame start to this day's local 00:00
  readonly lengthMinutes: number // 1440 normally; 1380 / 1500 on DST transitions
}

// SPEC-v2.md Section 3: DayFrame generalised to a multi-day frame. `dayCount`
// is always 1 in Drop 1, so this is arithmetically identical to the old
// single-day DayFrame; `date` is kept as a field (not just a getter) so every
// existing DayFrame consumer keeps working unchanged.
export interface Frame {
  readonly startDate: string // YYYY-MM-DD, local calendar date of day 0
  readonly date: string // alias of startDate (SPEC-v2.md Section 3.2 compatibility)
  readonly timezone: string // IANA zone, e.g. "Europe/Berlin"
  readonly startInstant: number // UTC epoch ms of local 00:00 on startDate
  readonly dayCount: number // SPEC-v2.1 §3: unpinned; capped at 366 (FRAME_TOO_LONG)
  readonly lengthMinutes: number // sum of days[].lengthMinutes
  readonly days: readonly Day[] // dayCount entries
  /** SPEC-v2.1 §3.2: implicit per-day window for activities with no WindowRule. */
  readonly defaultDayWindow?: {
    readonly startWall: string
    readonly endWall: string
  }
  /** SPEC-v2.1 §3.3: cap on backdating; blocks ending more than this many
   * minutes before `now` are marked SKIPPED/LAPSED instead of COMPLETED. */
  readonly backdateHorizonMinutes?: number
}

/** Retained name for the pre-Drop-1 single-day frame shape (SPEC-v2.md Section 3.2). */
export type DayFrame = Frame

export interface Interval {
  readonly start: number
  readonly end: number
}

// --- Rules -----------------------------------------------------------------

export type RuleSource = "template" | "instance"

export interface FixedRule {
  readonly type: "fixed"
  readonly source: RuleSource
  readonly startWall: string // "HH:MM"
  readonly endWall: string
}

// SPEC-v2.md Section 4.1: StrictWindowRule + FlexibleWindowRule + Activity.allowedDays
// merged into one WindowRule. A strict window is a flexible window with zero
// drift; "allowedDays" is the union of window `days` across an activity's
// WindowRules, not a separate filter. An activity may carry more than one
// WindowRule — the sole exception to "at most one rule of each type".
export interface WindowRule {
  readonly type: "window"
  readonly source: RuleSource
  readonly days: readonly Weekday[] // days this window applies on
  readonly startWall: string
  readonly endWall: string // <= startWall means the window spans midnight
  readonly maxDriftMinutes: number // 0 = strict
}

// SPEC-v2.md Section 4.3: ShrinkRule.minDuration/minChunk becomes ElasticityRule.
export interface ElasticityRule {
  readonly type: "elasticity"
  readonly source: RuleSource
  readonly minTotalMinutes: number // hard floor on total scheduled time (v1: minDurationMinutes)
  readonly minBlockMinutes: number // hard floor on any single block (v1: minChunkMinutes)
}

// SPEC-v2.md Section 4.2: ShrinkRule.chunkingAllowed/maxChunks becomes a
// RepeatRule with sharedBudget: true. sharedBudget is what distinguishes
// chunking (true: blocks draw on one shared duration budget, the solver
// minimises block count) from recurrence (false: each block carries its own
// full duration, the solver maximises block count up to `count`) — Drop 1
// permits only sharedBudget: true, period: "day", minSeparationMinutes: 0;
// the other values exist now so Drop 2 adds no type churn.
export interface RepeatRule {
  readonly type: "repeat"
  readonly source: RuleSource
  readonly period: "day" | "week" | "month" | "frame" // Drop 1: must be "day"
  readonly count: number // >= 1
  readonly sharedBudget: boolean // Drop 1: must be true
  readonly minSeparationMinutes: number // Drop 1: must be 0
}

export interface SequenceRule {
  readonly type: "sequence"
  readonly source: RuleSource
  readonly role: "pre" | "post"
  readonly linkedActivityId: string
  readonly maxGapMinutes: number
}

export interface ExclusionWindow {
  readonly id: string
  readonly name: string
  readonly anchor: "relative" | "absolute"
  // relative anchor
  readonly startOffset?: number
  readonly endOffset?: number
  // absolute anchor
  readonly startWall?: string
  readonly endWall?: string
}

export interface OverlapRule {
  readonly type: "overlap"
  readonly source: RuleSource
  readonly budgetMinutes: number
  readonly allowedGuestIds: readonly string[]
  readonly exclusionWindows: readonly ExclusionWindow[]
}

export type Rule =
  | FixedRule
  | WindowRule
  | ElasticityRule
  | RepeatRule
  | SequenceRule
  | OverlapRule

export type RuleType = Rule["type"]

// --- Activity (template) ----------------------------------------------------

export interface Activity {
  readonly id: string
  readonly name: string
  readonly durationMinutes: number
  readonly priorityRank: number
  readonly enabled: boolean
  readonly rules: readonly Rule[]
  // SPEC-v2.md Section 5: MandatoryRule becomes a field. 0 = discretionary
  // (skip costs W x SKIP); 1 = exactly v1's MandatoryRule (skip costs
  // Infinity, hard-set membership). Drop 1 permits only 0 or 1.
  readonly requiredCount: number
}

// --- TimelineActivity (instance) -------------------------------------------

export type InstanceState =
  "PLANNED" | "ACTIVE" | "COMPLETED" | "SKIPPED" | "CARRIED_IN"

export type CompletedSource = "user" | "auto" | "backdated"

export type SkipReason =
  | "NO_FREE_SPACE"
  | "WINDOW_UNSATISFIABLE"
  | "DRIFT_EXCEEDED"
  | "BUDGET_EXHAUSTED"
  | "HOST_SKIPPED"
  | "INFEASIBLE_HARD_CONSTRAINT"
  | "NOT_ALLOWED_TODAY"
  | "USER_SKIPPED"

export type RelaxationType = "drift" | "shrink" | "chunk" | "gap"

export interface Relaxation {
  readonly type: RelaxationType
  readonly minutes: number
}

export interface TimelineActivity {
  readonly id: string
  readonly activityId: string | null
  readonly date: string
  readonly name: string
  readonly durationMinutes: number
  readonly priorityRank: number
  readonly requiredCount: number
  readonly rules: readonly Rule[]
  readonly state: InstanceState
  readonly completedSource: CompletedSource | null
  readonly plannedStart: number | null
  readonly plannedEnd: number | null
  readonly actualStart: number | null
  readonly actualEnd: number | null
  readonly scheduledMinutes: number
  readonly occurrenceId: string
  readonly occurrenceIndex: number
  readonly bucketKey: string
  readonly blockIndex: number
  readonly blockCount: number
  readonly chunkGroupId: string | null
  readonly hostInstanceId: string | null
  readonly isAdhoc: boolean
  readonly spanningFromPreviousDay: boolean
  readonly relaxations: readonly Relaxation[]
  readonly locked: boolean
  readonly skipReason: SkipReason | null
}

// --- Diagnostics & cost ------------------------------------------------------

export type DiagnosticSeverity = "info" | "warning" | "blocking"

export interface Diagnostic {
  readonly severity: DiagnosticSeverity
  readonly code: string
  readonly instanceIds: readonly string[]
  readonly message: string
  readonly suggestedFix: string | null
}

export interface CostBreakdown {
  readonly total: number
  readonly skip: number
  readonly shrink: number
  readonly chunk: number
  readonly drift: number
  readonly gap: number
  readonly idle: number
  readonly perInstance: Readonly<Record<string, number>>
}

export interface CostConstants {
  readonly SKIP: number
  readonly SHRINK: number
  readonly CHUNK: number
  readonly DRIFT: number
  readonly GAP: number
  readonly IDLE: number
  readonly GRID: number
  readonly HARD_SET_NODE_LIMIT: number
}

// --- Timeline ----------------------------------------------------------------

export type TimelineStatus = "OK" | "DEGRADED"

export interface Timeline {
  readonly dayFrame: DayFrame
  readonly revision: number
  readonly instances: readonly TimelineActivity[]
  readonly diagnostics: readonly Diagnostic[]
  readonly cost: CostBreakdown
  readonly status: TimelineStatus
  readonly solvedAtOffset: number
  readonly finalised: boolean
  /** Residue for tomorrow's day frame (SPEC.md Section 9.8); empty until finalised. */
  readonly carryIn: readonly TimelineActivity[]
}

// --- Events --------------------------------------------------------------------

export interface AdhocPayload {
  readonly name: string
  readonly durationMinutes: number
  readonly priorityRank: number
  readonly rules: readonly Rule[]
  readonly date: string
  /** SPEC-v2.md Section 5: replaces v1's MandatoryRule. Defaults to 0. */
  readonly requiredCount?: number
}

export type Event =
  | { readonly type: "GENERATE_DAY" }
  | { readonly type: "TICK" }
  | {
      readonly type: "FINISH_EARLY"
      readonly instanceId: string
      readonly at: number
    }
  | {
      readonly type: "EXTEND"
      readonly instanceId: string
      readonly minutes: number
    }
  | { readonly type: "ADD_ADHOC"; readonly payload: AdhocPayload }
  | {
      readonly type: "EDIT_INSTANCE_RULES"
      readonly instanceId: string
      readonly rules: readonly Rule[]
    }
  | { readonly type: "SKIP"; readonly instanceId: string }
  | { readonly type: "RESTORE"; readonly instanceId: string }
  | { readonly type: "FINALISE_DAY" }

// --- Engine input / output -----------------------------------------------------

export interface SolveOptions {
  readonly trace?: boolean
}

export interface SolveInput {
  readonly dayFrame: DayFrame
  readonly now: number
  readonly catalog: readonly Activity[]
  readonly existing: readonly TimelineActivity[]
  readonly carryIn: readonly TimelineActivity[]
  readonly event: Event
  readonly constants?: Partial<CostConstants>
  readonly options?: SolveOptions
  /** The revision of `existing`, echoed back unchanged by a no-op TICK. */
  readonly revision?: number
  /** True once a prior FINALISE_DAY closed this day frame (SPEC.md 9.8). */
  readonly finalised?: boolean
}

export type RejectionCode =
  | "FIXED_COLLISION"
  | "MANDATORY_UNPLACEABLE"
  | "STRICT_WINDOW_VIOLATED"
  | "GUEST_WINDOW_VIOLATED"
  | "SEQUENCE_UNSATISFIABLE"
  | "SPANS_FROZEN_REGION"
  | "UNKNOWN_INSTANCE"
  | "INVALID_STATE_FOR_EVENT"

export interface RejectionError {
  readonly code: RejectionCode
  readonly message: string
  readonly conflictingInstanceIds: readonly string[]
  readonly diagnostics: readonly Diagnostic[]
  readonly bestEffortTimeline: Timeline | null
}

export interface Placement {
  readonly start: number
  readonly end: number
  readonly nestedIn: string | null
}

export interface DecisionRecord {
  readonly instanceId: string
  readonly chosen: Placement | null
  readonly runnerUp: Placement | null
  readonly reason: string
}

export interface SolveTrace {
  readonly phaseTimings: Readonly<Record<string, number>>
  readonly candidatesEvaluated: number
  readonly backtrackNodes: number
  readonly decisions: readonly DecisionRecord[]
}

export type SolveStatus = "OK" | "DEGRADED" | "REJECTED"

export interface SolveResult {
  readonly status: SolveStatus
  readonly timeline: Timeline
  readonly rejection: RejectionError | null
  readonly diagnostics: readonly Diagnostic[]
  readonly cost: CostBreakdown
  readonly trace: SolveTrace | null
}

// --- Validation ------------------------------------------------------------------

export type ValidationSeverity = "error" | "warning"

export interface ValidationIssue {
  readonly severity: ValidationSeverity
  readonly code: string
  readonly activityId: string | null
  readonly message: string
}

// --- Window resolution (SPEC-v2.1 §4) ---------------------------------------

/** An activity's WindowRule resolved to numeric frame-relative offsets, for
 *  one matching day (SPEC-v2.1 §4: one ResolvedWindow per rule × eligible day,
 *  not per rule). Lives here (not resolve.ts) so `Occurrence` can reference it
 *  without a resolve.ts → types.ts → resolve.ts import cycle. */
export interface ResolvedWindow {
  readonly start: number
  readonly end: number
  readonly maxDriftMinutes: number
  readonly dayIndex: number
  /** SPEC-v2.1 §4's "eligible day span" for this window, frame-relative:
   *  the full calendar-day span of `dayIndex` (and the following day too,
   *  for a window that spans midnight — its own `end` already lies there).
   *  A hard bound drift may never cross: softening the window must never
   *  soften day eligibility (§4, "a candidate could otherwise bleed out of
   *  Tuesday's window far enough to land on Wednesday"). */
  readonly daySpanStart: number
  readonly daySpanEnd: number
}

// --- Expansion (SPEC-v2.1 §5) -----------------------------------------------

/** SPEC-v2.1 §5.2: an activity's expanded form for one (bucket, index).
 *  `windows` is the activity's resolved windows intersected with the bucket
 *  — empty after intersection means the bucket produced no occurrence. */
export interface Occurrence {
  readonly id: string
  readonly activity: Activity
  readonly bucketKey: string
  readonly index: number // 1-based within the bucket
  readonly windows: readonly ResolvedWindow[]
  readonly required: boolean // index ≤ activity.requiredCount
  readonly siblingIds: readonly string[]
}

/** Read-only interval shape used by expand() to scope a bucket. */
export interface BucketSpan {
  readonly key: string
  readonly start: number
  readonly end: number
  /** Set only for `period: "day"` buckets: the frame-relative index of the
   *  single day this bucket represents. A spanning window's `dayIndex` is
   *  the day it starts on, so day buckets select windows by this field
   *  rather than by span overlap — a span-overlap intersection would let a
   *  midnight-crossing window bleed into the following day's bucket too,
   *  producing a phantom second occurrence for one recurrence. */
  readonly dayIndex?: number
}

/** SPEC-v2.1 §5.1: the day's repetition ledger — `placed[bucketKey]` is how
 *  many of `activityId` have already been placed in that bucket by an
 *  earlier (carry-over) solve. Drop 2's full form: not yet populated — Step
 *  6 introduces it alongside `Plan.quotas`. Until then, `expand` always
 *  treats `placed` as the zero map, so a single multi-day GENERATE_DAY still
 *  emits one occurrence per eligible bucket per (activity, count). */
export interface RepeatQuotas {
  readonly placed: ReadonlyMap<string, ReadonlyMap<string, number>>
}
