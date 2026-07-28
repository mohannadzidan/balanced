import { violatesDominance } from "./cost"
import { eligibleWeekdaysOf } from "./resolve"
import { overlapRuleOf } from "./overlap"
import { sequenceRuleOf } from "./sequence"
import type {
  Activity,
  CostConstants,
  Rule,
  RuleType,
  ShrinkRule,
  ValidationIssue,
  WindowRule,
} from "./types"

const FORBIDDEN_PAIRS: ReadonlyArray<readonly [RuleType, RuleType]> = [
  ["fixed", "window"],
  ["fixed", "shrink"],
]

function pairForbidden(a: RuleType, b: RuleType): boolean {
  return FORBIDDEN_PAIRS.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a)
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
  activityId: string,
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
      const duplicateType = a.type === b.type && a.type !== "window"
      const forbiddenPair =
        pairForbidden(a.type, b.type) &&
        !(isDayOnlyWindow(a) || isDayOnlyWindow(b))
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
    if (rule.type === "shrink") {
      if (
        !isOnGrid(rule.minDurationMinutes, grid) ||
        !isOnGrid(rule.minChunkMinutes, grid)
      ) {
        issues.push(
          issue(
            "error",
            "DURATION_NOT_ON_GRID",
            activity.id,
            `"${activity.name}" shrink floor or chunk minimum is not a multiple of ${grid}`
          )
        )
      }
    }
  }
}

function checkShrinkFloor(
  activity: Activity,
  rule: ShrinkRule,
  issues: ValidationIssue[]
): void {
  if (rule.minDurationMinutes > activity.durationMinutes) {
    issues.push(
      issue(
        "error",
        "SHRINK_FLOOR_INVALID",
        activity.id,
        `"${activity.name}" shrink floor ${rule.minDurationMinutes}m exceeds its duration ${activity.durationMinutes}m`
      )
    )
  }
  if (rule.minChunkMinutes > rule.minDurationMinutes) {
    issues.push(
      issue(
        "error",
        "SHRINK_FLOOR_INVALID",
        activity.id,
        `"${activity.name}" minimum chunk ${rule.minChunkMinutes}m exceeds its shrink floor ${rule.minDurationMinutes}m`
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
  const hasShrink = activity.rules.some((r) => r.type === "shrink")
  if (windowLength < activity.durationMinutes && !hasShrink) {
    issues.push(
      issue(
        "warning",
        "WINDOW_TOO_SHORT",
        activity.id,
        `"${activity.name}" strict window (${windowLength}m) is shorter than its duration (${activity.durationMinutes}m) and has no ShrinkRule`
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

/** Pure predicates over a single Activity template (SPEC.md Section 10.1). */
export function validateActivity(
  activity: Activity,
  constants: CostConstants
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  checkRuleIncompatibility(activity, issues)
  checkGridAlignment(activity, constants, issues)

  for (const rule of activity.rules as readonly Rule[]) {
    if (rule.type === "shrink") checkShrinkFloor(activity, rule, issues)
    if (rule.type === "window") {
      checkWindowInverted(activity, rule, issues)
      checkWindowTooShort(activity, rule, issues)
      checkDriftUnavoidable(activity, rule, issues)
    }
  }

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
        "NO_ALLOWED_DAYS",
        activity.id,
        `"${activity.name}" has no allowed days and will never be generated`
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
