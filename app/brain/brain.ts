/**
 * Public API of the Dynamic Day Scheduler engine.
 *
 * Everything a caller needs to build a day's catalog, run the solver, and
 * read back a schedule lives behind this file — `app/brain/engine/*` is
 * implementation detail (placement search, backtracking, cost internals)
 * and should not be imported directly outside `app/brain/engine`. The full
 * behavioral specification is `app/brain/SPEC.md`; this file is the
 * "how do I call it" surface, not a restatement of the rules.
 *
 * ## Mental model
 *
 * `solve()` is a pure function: `(SolveInput) => SolveResult`. It never
 * mutates its input, performs no I/O, and takes `now` as an explicit
 * argument rather than reading the clock — the caller owns persistence and
 * time. Every user action (loading the day, a tick, finishing a task early,
 * adding an ad-hoc activity, ...) is one `Event` fed through the same
 * `solve()` call; there is no separate "apply an update" API.
 *
 * ## Minimal usage
 *
 * ```ts
 * import {
 *   activity,
 *   resolveDayFrame,
 *   solve,
 *   validateCatalog,
 * } from "@/app/brain/brain"
 *
 * const dayFrame = resolveDayFrame("2026-07-27", "America/New_York")
 *
 * const catalog = [
 *   activity("Gym").rank(1).minutes(60).flexible("18:00", "20:00", { drift: 15 }).build(),
 *   activity("Standup").rank(2).minutes(15).fixed("09:00", "09:15").build(),
 * ]
 *
 * const issues = validateCatalog(catalog) // surface template mistakes before solving
 *
 * const result = solve({
 *   dayFrame,
 *   now: 0,
 *   catalog,
 *   existing: [],   // yesterday's finalised state, or [] for a fresh day
 *   carryIn: [],    // midnight-spanning residue from yesterday, if any
 *   event: { type: "GENERATE_DAY" },
 * })
 *
 * result.timeline.instances   // the schedule
 * result.timeline.diagnostics // warnings/explanations (shrinks, chunks, skips)
 * result.timeline.cost        // cost breakdown, for comparing alternatives
 * result.status               // "OK" | "DEGRADED" | "REJECTED"
 * ```
 *
 * Subsequent calls pass the previous `result.timeline.instances` back in as
 * `existing`, with a new `event` (e.g. `{ type: "TICK" }` or
 * `{ type: "FINISH_EARLY", instanceId, at }`). At end of day, send
 * `{ type: "FINALISE_DAY" }` and carry `result.timeline.carryIn` into
 * tomorrow's `carryIn`.
 */

// --- Entry point -------------------------------------------------------------

export { solve } from "./engine/solve"

// --- Building a catalog --------------------------------------------------------

/** Fluent builder for `Activity` templates — start here instead of hand-assembling `Rule` objects. */
export { activity, ActivityBuilder } from "./engine/activity-builder"

// --- Pre-flight checks ---------------------------------------------------------

/** Catches template mistakes (bad windows, incompatible rules, ...) before they reach `solve()`. */
export { validateActivity, validateCatalog } from "./engine/validation"

// --- Time / day-frame helpers ----------------------------------------------------

/** Resolves a local calendar date + IANA timezone into the `DayFrame` `solve()` expects, DST-aware. */
export { resolveDayFrame, weekdayOf, addDays } from "./engine/time"

// --- Cost tuning -----------------------------------------------------------------

/** The engine's default relaxation weights; pass `{ constants: {...} }` in `SolveInput` to override any subset. */
export { DEFAULT_COST_CONSTANTS } from "./engine/constants"

// --- Debug / display -------------------------------------------------------------

/** Deterministic ASCII rendering of a `Timeline`, handy for logs and snapshot assertions. */
export { renderAscii } from "./engine/render"

// --- Types -------------------------------------------------------------------------

export type {
  // Rules (SPEC.md Section 5) and the templates/instances built from them
  Weekday,
  Rule,
  RuleType,
  RuleSource,
  FixedRule,
  WindowRule,
  MandatoryRule,
  ShrinkRule,
  SequenceRule,
  OverlapRule,
  ExclusionWindow,
  Activity,

  // The solved schedule
  DayFrame,
  TimelineActivity,
  InstanceState,
  CompletedSource,
  SkipReason,
  RelaxationType,
  Relaxation,
  Timeline,
  TimelineStatus,

  // Diagnostics & cost
  Diagnostic,
  DiagnosticSeverity,
  CostBreakdown,
  CostConstants,

  // Driving the solver
  Event,
  AdhocPayload,
  SolveInput,
  SolveOptions,
  SolveResult,
  SolveStatus,
  RejectionError,
  RejectionCode,

  // Validation
  ValidationIssue,
  ValidationSeverity,
} from "./engine/types"
