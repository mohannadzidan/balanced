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
