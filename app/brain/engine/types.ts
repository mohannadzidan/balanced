// Domain types for the Dynamic Day Scheduler engine.
// See app/brain/SPEC.md for the full specification these types implement.

export type Weekday = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT"

export interface DayFrame {
  readonly date: string // YYYY-MM-DD, local calendar date
  readonly timezone: string // IANA zone, e.g. "Europe/Berlin"
  readonly startInstant: number // UTC epoch ms of local 00:00 on this date
  readonly lengthMinutes: number // 1440 normally; 1380 / 1500 on DST transitions
}

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

export interface StrictWindowRule {
  readonly type: "strictWindow"
  readonly source: RuleSource
  readonly startWall: string
  readonly endWall: string
}

export interface FlexibleWindowRule {
  readonly type: "flexibleWindow"
  readonly source: RuleSource
  readonly startWall: string
  readonly endWall: string
  readonly maxDriftMinutes: number
}

export interface MandatoryRule {
  readonly type: "mandatory"
  readonly source: RuleSource
}

export interface ShrinkRule {
  readonly type: "shrink"
  readonly source: RuleSource
  readonly minDurationMinutes: number
  readonly chunkingAllowed: boolean
  readonly minChunkMinutes: number
  readonly maxChunks: number
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
  | StrictWindowRule
  | FlexibleWindowRule
  | MandatoryRule
  | ShrinkRule
  | SequenceRule
  | OverlapRule

export type RuleType = Rule["type"]

// --- Activity (template) ----------------------------------------------------

export interface Activity {
  readonly id: string
  readonly name: string
  readonly durationMinutes: number
  readonly priorityRank: number
  readonly allowedDays: readonly Weekday[]
  readonly enabled: boolean
  readonly rules: readonly Rule[]
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
  readonly rules: readonly Rule[]
  readonly state: InstanceState
  readonly completedSource: CompletedSource | null
  readonly plannedStart: number | null
  readonly plannedEnd: number | null
  readonly actualStart: number | null
  readonly actualEnd: number | null
  readonly scheduledMinutes: number
  readonly chunkIndex: number
  readonly chunkCount: number
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
}

// --- Events --------------------------------------------------------------------

export interface AdhocPayload {
  readonly name: string
  readonly durationMinutes: number
  readonly priorityRank: number
  readonly rules: readonly Rule[]
  readonly date: string
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
