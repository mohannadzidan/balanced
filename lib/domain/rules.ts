import { rangeContains, rangesOverlap, type TimeRange } from "@/lib/time"
import type { TemporalPlacementRule } from "@/lib/domain/types"

/**
 * Scheduling rule checks, as pure functions.
 *
 * Each check returns a `RuleVerdict` rather than a boolean because callers
 * branch on the *classification* of a failure, not merely on its presence:
 *
 * - `hard`  ⇒ reject the write; nothing is persisted and the message is shown
 *             to the user as the reason the save failed.
 * - `soft`  ⇒ persist the write anyway and return the message as a warning.
 *
 * A boolean cannot carry that distinction, and a thrown error would force
 * every caller into try/catch for an outcome that is ordinary, not exceptional.
 *
 * These functions never touch the database or the browser — that purity is
 * what makes them directly unit-testable. Keep this module small: Constitution
 * V (YAGNI) rules out a generic or configurable rule engine here. New checks
 * are plain functions appended below.
 */

/** The result of a single rule check. */
export type RuleVerdict =
  { ok: true } | { ok: false; classification: "hard" | "soft"; message: string }

/** A passing verdict. */
export function ok(): RuleVerdict {
  return { ok: true }
}

/** A failing verdict that must block the write. */
export function hard(message: string): RuleVerdict {
  return { ok: false, classification: "hard", message }
}

/** A failing verdict that allows the write but warns the user. */
export function soft(message: string): RuleVerdict {
  return { ok: false, classification: "soft", message }
}

/**
 * FR-005: a saved time range must have positive length.
 *
 * Equal start and end times are rejected alongside reversed ones — a
 * zero-length block has nothing to schedule.
 */
export function checkEndAfterStart(
  startMin: number,
  endMin: number
): RuleVerdict {
  if (endMin <= startMin) {
    return hard("End time must be after start time.")
  }
  return ok()
}

/**
 * data-model.md §2: a Strict activity's placement rule is meaningless unless
 * it is itself a Strict Window — "preferred" cannot apply to times that are
 * fixed, not merely favored — and its range must still satisfy FR-005.
 *
 * Both failures are Hard: a strict activity with a malformed or
 * wrongly-classified placement has nothing valid to schedule against.
 */
export function checkStrictActivityPlacement(
  rule: TemporalPlacementRule
): RuleVerdict {
  if (rule.kind !== "strict") {
    return hard("A Strict activity's placement must be a Strict Window.")
  }
  return checkEndAfterStart(rule.startMin, rule.endMin)
}

/**
 * data-model.md §4 Edge Case: each supplied transition (0–2, pre and/or
 * post) must itself satisfy FR-005. Deliberately does not check adjacency to
 * the parent activity — a gap between a transition and its parent is
 * allowed, and the transition renders at its own recorded times.
 */
export function checkTransitions(
  transitions: Array<{ startMin: number; endMin: number }>
): RuleVerdict {
  for (const transition of transitions) {
    const verdict = checkEndAfterStart(transition.startMin, transition.endMin)
    if (!verdict.ok) return verdict
  }
  return ok()
}

/**
 * data-model.md §2: whether a Flexible block falls inside its activity's
 * Temporal Placement window. A block outside a `"strict"` window is Hard
 * (rejected, FR-016); outside a `"preferred"` window is Soft (persisted and
 * flagged, FR-017). Touching the window's edges counts as inside
 * (`rangeContains` allows shared endpoints).
 */
export function evaluatePlacement(
  rule: TemporalPlacementRule,
  startMin: number,
  endMin: number
): RuleVerdict {
  const window: TimeRange = { startMin: rule.startMin, endMin: rule.endMin }
  if (rangeContains(window, { startMin, endMin })) {
    return ok()
  }
  if (rule.kind === "strict") {
    return hard("Block falls outside the activity's Strict Window.")
  }
  return soft("Block falls outside the activity's Preferred Window.")
}

/**
 * FR-016: a standalone block must not intersect any already-occupied range
 * on the day's timeline. Intersection requires positive-length overlap —
 * back-to-back blocks sharing an endpoint are not a conflict. Always Hard.
 */
export function checkNoOverlap(
  range: TimeRange,
  occupiedRanges: TimeRange[]
): RuleVerdict {
  for (const occupied of occupiedRanges) {
    if (rangesOverlap(range, occupied)) {
      return hard("Block overlaps an existing block on the timeline.")
    }
  }
  return ok()
}
