import { violatesDominance } from "./cost"
import { eligibleWeekdaysOf } from "./resolve"
import { overlapRuleOf } from "./overlap"
import { sequenceRuleOf } from "./sequence"
import type {
  Activity,
  CostConstants,
  DayFrame,
  ElasticityRule,
  RepeatRule,
  Rule,
  RuleType,
  ValidationIssue,
  WindowRule,
} from "./types"

const FORBIDDEN_PAIRS: ReadonlyArray<readonly [RuleType, RuleType]> = [
  ["fixed", "window"],
  ["fixed", "elasticity"],
]

function pairForbidden(a: RuleType, b: RuleType): boolean {
  return FORBIDDEN_PAIRS.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a)
  )
}

/**
 * A Fixed x chunking-repeat pair (`sharedBudget: true`) is still forbidden —
 * shrinking or splitting a block with a declared exact time makes no sense.
 * A Fixed x recurrence-repeat pair (`sharedBudget: false`) is legal since
 * SPEC-v2.1 §7.1: "daily standups across a month" is exactly a FixedRule
 * paired with a recurrence RepeatRule for a period other than the implicit
 * default. `checkFixedWithMultiCount` separately catches the case that's
 * still always wrong: more than one such occurrence per bucket.
 */
function isFixedWithChunkingRepeat(a: Rule, b: Rule): boolean {
  const fixed = a.type === "fixed" ? a : b.type === "fixed" ? b : null
  const repeat = a.type === "repeat" ? a : b.type === "repeat" ? b : null
  return (
    fixed !== null && repeat !== null && (repeat as RepeatRule).sharedBudget
  )
}

/**
 * The whole-day, zero-drift marker WindowRule the builder synthesizes to
 * carry a `.days()` restriction when no real time-of-day window exists
 * (activity-builder.ts). It imposes no actual time constraint, so it's
 * exempt from the Fixed x Window incompatibility (SPEC-v2.md Section 4.6) —
 * that exclusion is about conflicting time constraints, not day eligibility.
 */
function isDayOnlyWindow(rule: Rule): boolean {
  return (
    rule.type === "window" &&
    rule.startWall === "00:00" &&
    rule.endWall === "24:00" &&
    rule.maxDriftMinutes === 0
  )
}

function minutesOfDay(wall: string): number {
  const [h, m] = wall.split(":").map(Number)
  return h * 60 + m
}

function isOnGrid(minutes: number, grid: number): boolean {
  return minutes % grid === 0
}

function issue(
  severity: ValidationIssue["severity"],
  code: string,
  activityId: string | null,
  message: string
): ValidationIssue {
  return { severity, code, activityId, message }
}

function checkRuleIncompatibility(
  activity: Activity,
  issues: ValidationIssue[]
): void {
  const rules = activity.rules
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]
      const b = rules[j]
      // SPEC-v2.md Section 4.1: an activity may carry more than one
      // WindowRule — the sole exception to "at most one rule of each type".
      // RepeatRule duplicates are handled separately as REPEAT_DUPLICATE
      // (Section 8.2), since two are legal as long as their sharedBudget
      // values differ.
      const duplicateType =
        a.type === b.type && a.type !== "window" && a.type !== "repeat"
      const forbiddenPair =
        (pairForbidden(a.type, b.type) &&
          !(isDayOnlyWindow(a) || isDayOnlyWindow(b))) ||
        isFixedWithChunkingRepeat(a, b)
      if (duplicateType || forbiddenPair) {
        issues.push(
          issue(
            "error",
            "RULE_INCOMPATIBLE",
            activity.id,
            `"${activity.name}" cannot combine a ${a.type} rule with a ${b.type} rule`
          )
        )
      }
    }
  }
}

function checkGridAlignment(
  activity: Activity,
  constants: CostConstants,
  issues: ValidationIssue[]
): void {
  const grid = constants.GRID
  if (!isOnGrid(activity.durationMinutes, grid)) {
    issues.push(
      issue(
        "error",
        "DURATION_NOT_ON_GRID",
        activity.id,
        `"${activity.name}" duration ${activity.durationMinutes}m is not a multiple of ${grid}`
      )
    )
  }

  for (const rule of activity.rules) {
    if (rule.type === "fixed" || rule.type === "window") {
      if (
        !isOnGrid(minutesOfDay(rule.startWall), grid) ||
        !isOnGrid(minutesOfDay(rule.endWall), grid)
      ) {
        issues.push(
          issue(
            "error",
            "DURATION_NOT_ON_GRID",
            activity.id,
            `"${activity.name}" ${rule.type} window boundary is not a multiple of ${grid}`
          )
        )
      }
    }
    if (rule.type === "elasticity") {
      if (
        !isOnGrid(rule.minTotalMinutes, grid) ||
        !isOnGrid(rule.minBlockMinutes, grid)
      ) {
        issues.push(
          issue(
            "error",
            "DURATION_NOT_ON_GRID",
            activity.id,
            `"${activity.name}" elasticity floor or block minimum is not a multiple of ${grid}`
          )
        )
      }
    }
  }
}

/** SPEC-v2.md Section 4.3: minBlockMinutes <= minTotalMinutes <= durationMinutes must hold. */
function checkElasticityInvalid(
  activity: Activity,
  rule: ElasticityRule,
  issues: ValidationIssue[]
): void {
  if (rule.minTotalMinutes > activity.durationMinutes) {
    issues.push(
      issue(
        "error",
        "ELASTICITY_INVALID",
        activity.id,
        `"${activity.name}" elasticity floor ${rule.minTotalMinutes}m exceeds its duration ${activity.durationMinutes}m`
      )
    )
  }
  if (rule.minBlockMinutes > rule.minTotalMinutes) {
    issues.push(
      issue(
        "error",
        "ELASTICITY_INVALID",
        activity.id,
        `"${activity.name}" minimum block ${rule.minBlockMinutes}m exceeds its elasticity floor ${rule.minTotalMinutes}m`
      )
    )
  }
}

function checkWindowInverted(
  activity: Activity,
  rule: WindowRule,
  issues: ValidationIssue[]
): void {
  if (minutesOfDay(rule.endWall) <= minutesOfDay(rule.startWall)) {
    issues.push(
      issue(
        "error",
        "WINDOW_INVERTED",
        activity.id,
        `"${activity.name}" window end must be after its start`
      )
    )
  }
}

/** Strict-equivalent windows only (SPEC-v2.md Section 4.1: maxDriftMinutes 0). */
function checkWindowTooShort(
  activity: Activity,
  rule: WindowRule,
  issues: ValidationIssue[]
): void {
  if (rule.maxDriftMinutes !== 0 || isDayOnlyWindow(rule)) return
  const windowLength = minutesOfDay(rule.endWall) - minutesOfDay(rule.startWall)
  const hasElasticity = activity.rules.some((r) => r.type === "elasticity")
  if (windowLength < activity.durationMinutes && !hasElasticity) {
    issues.push(
      issue(
        "warning",
        "WINDOW_TOO_SHORT",
        activity.id,
        `"${activity.name}" strict window (${windowLength}m) is shorter than its duration (${activity.durationMinutes}m) and has no ElasticityRule`
      )
    )
  }
}

/** Flexible-equivalent windows only (SPEC-v2.md Section 4.1: maxDriftMinutes > 0). */
function checkDriftUnavoidable(
  activity: Activity,
  rule: WindowRule,
  issues: ValidationIssue[]
): void {
  if (rule.maxDriftMinutes === 0) return
  const windowLength = minutesOfDay(rule.endWall) - minutesOfDay(rule.startWall)
  const unavoidable = activity.durationMinutes - windowLength
  if (unavoidable > rule.maxDriftMinutes) {
    issues.push(
      issue(
        "warning",
        "DRIFT_UNAVOIDABLE",
        activity.id,
        `"${activity.name}" needs at least ${unavoidable}m of drift but allows only ${rule.maxDriftMinutes}m`
      )
    )
  }
}

/**
 * SPEC-v2.1 §13.1 step 3: `sharedBudget` and `period ≠ "day"` are now
 * wired into placement; step 4 wires `minSeparationMinutes` too. The only
 * remaining reason this gate exists is to reserve a choke point for any
 * future RepeatRule field that lands before its placement story — it is
 * currently a no-op.
 */
function checkNotYetSupported(
  activity: Activity,
  rule: RepeatRule,
  issues: ValidationIssue[]
): void {
  void rule
  void activity
  void issues
}

/** SPEC-v2.md Section 8.2: two RepeatRules with the same sharedBudget value. */
function checkRepeatDuplicate(
  activity: Activity,
  issues: ValidationIssue[]
): void {
  const repeats = activity.rules.filter(
    (r): r is RepeatRule => r.type === "repeat"
  )
  const seen = new Set<boolean>()
  for (const rule of repeats) {
    if (seen.has(rule.sharedBudget)) {
      issues.push(
        issue(
          "error",
          "REPEAT_DUPLICATE",
          activity.id,
          `"${activity.name}" has two RepeatRules with sharedBudget: ${rule.sharedBudget}`
        )
      )
    }
    seen.add(rule.sharedBudget)
  }
}

/**
 * SPEC-v2.1 §7.1/§13.2: a FixedRule occurrence has a declared exact time, so
 * a bucket holding more than one of them always collides — the recurrence
 * direction's `count` is capped at 1 wherever a FixedRule is present.
 */
function checkFixedWithMultiCount(
  activity: Activity,
  issues: ValidationIssue[]
): void {
  const hasFixed = activity.rules.some((r) => r.type === "fixed")
  if (!hasFixed) return
  const recurrence = activity.rules.find(
    (r): r is RepeatRule => r.type === "repeat" && !r.sharedBudget
  )
  if (recurrence && recurrence.count > 1) {
    issues.push(
      issue(
        "error",
        "FIXED_WITH_MULTI_COUNT",
        activity.id,
        `"${activity.name}" combines a FixedRule with a RepeatRule count of ${recurrence.count} — two occurrences at the same declared time always collide`
      )
    )
  }
}

/** Pure predicates over a single Activity template (SPEC.md Section 10.1). */
export function validateActivity(
  activity: Activity,
  constants: CostConstants
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  checkRuleIncompatibility(activity, issues)
  checkGridAlignment(activity, constants, issues)

  for (const rule of activity.rules as readonly Rule[]) {
    if (rule.type === "elasticity")
      checkElasticityInvalid(activity, rule, issues)
    if (rule.type === "repeat") checkNotYetSupported(activity, rule, issues)
    if (rule.type === "window") {
      checkWindowInverted(activity, rule, issues)
      checkWindowTooShort(activity, rule, issues)
      checkDriftUnavoidable(activity, rule, issues)
    }
  }
  checkRepeatDuplicate(activity, issues)
  checkFixedWithMultiCount(activity, issues)

  if (violatesDominance(activity, constants)) {
    issues.push(
      issue(
        "error",
        "DOMINANCE_VIOLATION",
        activity.id,
        `"${activity.name}" relaxations are cheap enough that the solver may skip it instead of relaxing it — widen the gap between SKIP and its relaxation allowances`
      )
    )
  }

  if (eligibleWeekdaysOf(activity).size === 0) {
    issues.push(
      issue(
        "warning",
        "NO_ELIGIBLE_DAYS",
        activity.id,
        `"${activity.name}" has no allowed days and will never be generated`
      )
    )
  }

  // SPEC-v2.1 §13.1: requiredCount < 0 or > count is now invalid; the upper
  // bound widens from 1 (Drop 1) to count (the recurrence's count). "At
  // most as many required occurrences as the activity declares" — anything
  // beyond that is an authoring mistake.
  const repeatCount = activity.rules
    .filter((r): r is RepeatRule => r.type === "repeat" && !r.sharedBudget)
    .reduce((max, r) => Math.max(max, r.count), 1)
  if (activity.requiredCount < 0 || activity.requiredCount > repeatCount) {
    issues.push(
      issue(
        "error",
        "REQUIRED_COUNT_INVALID",
        activity.id,
        `"${activity.name}" requiredCount ${activity.requiredCount} must be in [0, ${repeatCount}]`
      )
    )
  }

  return issues
}

function checkSequenceMultiple(
  activities: readonly Activity[],
  issues: ValidationIssue[]
): void {
  const seen = new Map<string, Activity>() // key: `${hostId}:${role}`
  for (const activity of activities) {
    const rule = sequenceRuleOf(activity)
    if (!rule) continue
    const key = `${rule.linkedActivityId}:${rule.role}`
    const existing = seen.get(key)
    if (existing) {
      issues.push(
        issue(
          "error",
          "SEQUENCE_MULTIPLE",
          activity.id,
          `"${activity.name}" and "${existing.name}" are both a "${rule.role}" of the same host`
        )
      )
    } else {
      seen.set(key, activity)
    }
  }
}

function checkSequenceCycle(
  activities: readonly Activity[],
  issues: ValidationIssue[]
): void {
  const byId = new Map(activities.map((a) => [a.id, a]))
  const flagged = new Set<string>()

  for (const start of activities) {
    if (flagged.has(start.id)) continue
    const path: string[] = []
    const onPath = new Set<string>()
    let current: Activity | undefined = start
    while (current) {
      if (onPath.has(current.id)) {
        for (const id of path.slice(path.indexOf(current.id))) flagged.add(id)
        break
      }
      const rule = sequenceRuleOf(current)
      if (!rule) break
      path.push(current.id)
      onPath.add(current.id)
      current = byId.get(rule.linkedActivityId)
    }
  }

  for (const id of flagged) {
    const activity = byId.get(id)
    if (!activity) continue
    issues.push(
      issue(
        "error",
        "SEQUENCE_CYCLE",
        activity.id,
        `"${activity.name}" is part of a sequence cycle`
      )
    )
  }
}

function checkGuestOutranksHost(
  activities: readonly Activity[],
  issues: ValidationIssue[]
): void {
  const byId = new Map(activities.map((a) => [a.id, a]))
  for (const host of activities) {
    const rule = overlapRuleOf(host)
    if (!rule) continue
    for (const guestId of rule.allowedGuestIds) {
      const guest = byId.get(guestId)
      if (guest && guest.priorityRank < host.priorityRank) {
        issues.push(
          issue(
            "warning",
            "GUEST_OUTRANKS_HOST",
            guest.id,
            `"${guest.name}" outranks its host "${host.name}" — it will be placed before the host and nesting will never be considered`
          )
        )
      }
    }
  }
}

/** Cross-activity checks over the whole catalogue (SPEC.md Section 10.1). */
export function validateCatalog(
  activities: readonly Activity[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const seenRanks = new Map<number, Activity>()
  for (const activity of activities) {
    const existing = seenRanks.get(activity.priorityRank)
    if (existing) {
      issues.push(
        issue(
          "error",
          "PRIORITY_DUPLICATE",
          activity.id,
          `"${activity.name}" and "${existing.name}" share priority rank ${activity.priorityRank}`
        )
      )
    } else {
      seenRanks.set(activity.priorityRank, activity)
    }
  }

  checkSequenceMultiple(activities, issues)
  checkSequenceCycle(activities, issues)
  checkGuestOutranksHost(activities, issues)

  return issues
}

/**
 * SPEC-v2.1 §6.1/§13.2: pure-arithmetic pre-flight for a recurrence with
 * `minSeparationMinutes > 0`. Emits `SEPARATION_UNSATISFIABLE` when even
 * the tightest realistic bucket (a day, for non-frame periods; the full
 * frame, for `period: "frame"`) cannot hold `count` sessions separated by
 * `minSeparationMinutes` — `(count × duration) + ((count − 1) × minSeparation)
 * > bucketLength`. This catches the common authoring mistake (e.g.
 * "three times a day, 6h apart" against a 60-minute duration) without
 * running a solve.
 *
 * Caller is expected to invoke this before `solve()` — like
 * `validateActivity`, this is not auto-run inside the solver.
 */
export function validateSeparation(
  activity: Activity,
  dayFrame: DayFrame
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const repeats = activity.rules.filter(
    (r): r is RepeatRule => r.type === "repeat" && !r.sharedBudget
  )
  for (const rule of repeats) {
    if (rule.minSeparationMinutes <= 0) continue
    const sep = rule.minSeparationMinutes
    const count = rule.count
    const duration = activity.durationMinutes
    // Tightest realistic bucket: a single day for any period smaller than
    // `frame`, the full frame for `period: "frame"`. If the day-bucket
    // already fits, the activity is feasible across every bucket shape;
    // if it doesn't, the activity cannot fit any way the recurrence can
    // be configured. The arithmetic is an upper bound on real bucket
    // extent — fine for a "this catalog entry is fundamentally broken"
    // signal, not for sizing specific buckets.
    const smallestBucketLength =
      rule.period === "frame"
        ? dayFrame.lengthMinutes
        : dayFrame.days.length > 0
          ? dayFrame.days[0].lengthMinutes
          : dayFrame.lengthMinutes
    if (count * duration + (count - 1) * sep > smallestBucketLength) {
      issues.push(
        issue(
          "error",
          "SEPARATION_UNSATISFIABLE",
          activity.id,
          `"${activity.name}" requires ${count} × ${duration}m + ${count - 1} × ${sep}m separation (>${smallestBucketLength}m smallest bucket)`
        )
      )
    }
  }
  return issues
}

/**
 * SPEC-v2.1 §3 / §13.2: pre-flight check for the Frame itself.
 * Emits FRAME_TOO_LONG for dayCount > 366, FRAME_DEFAULT_WINDOW_INVALID
 * for a malformed `defaultDayWindow`, and FRAME_BACKDATE_HORIZON_INVALID
 * for a non-positive `backdateHorizonMinutes`. Caller is expected to
 * invoke this before `solve()` — like `validateActivity` and
 * `validateCatalog`, this is not auto-run inside the solver.
 */
export function validateFrame(frame: DayFrame): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (frame.dayCount > 366) {
    issues.push(
      issue(
        "error",
        "FRAME_TOO_LONG",
        null,
        `Frame spans ${frame.dayCount} days; the cap is 366.`
      )
    )
  }

  const dw = frame.defaultDayWindow
  if (dw !== undefined) {
    const wallRe = /^([01]\d|2[0-3]):[0-5]\d$/
    if (!wallRe.test(dw.startWall) || !wallRe.test(dw.endWall)) {
      issues.push(
        issue(
          "error",
          "FRAME_DEFAULT_WINDOW_INVALID",
          null,
          `Frame.defaultDayWindow must use "HH:MM" wall-clock form for startWall and endWall; got ${JSON.stringify(dw)}.`
        )
      )
    }
  }

  if (
    frame.backdateHorizonMinutes !== undefined &&
    (!Number.isFinite(frame.backdateHorizonMinutes) ||
      frame.backdateHorizonMinutes < 0)
  ) {
    issues.push(
      issue(
        "error",
        "FRAME_BACKDATE_HORIZON_INVALID",
        null,
        `Frame.backdateHorizonMinutes must be a non-negative number; got ${frame.backdateHorizonMinutes}.`
      )
    )
  }

  return issues
}
