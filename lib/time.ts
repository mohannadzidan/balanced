/**
 * Time-of-day arithmetic for the daily timeline.
 *
 * Every time-of-day value in this app is an integer number of minutes from
 * midnight (0–1439) so that window, overlap, budget, and union math are plain
 * numeric comparisons. Nothing outside this module does date/time arithmetic
 * on strings (Constitution II, research §10).
 */

/** Minutes in a full day. */
export const MINUTES_PER_DAY = 1440

/** Largest valid minute-of-day value. */
export const MAX_MINUTE_OF_DAY = MINUTES_PER_DAY - 1

/** A half-open interval within one day, in minutes from midnight. */
export type TimeRange = {
  startMin: number
  endMin: number
}

const HHMM_PATTERN = /^(\d{1,2}):(\d{2})$/

/**
 * Parse an `"HH:MM"` clock time into minutes from midnight.
 *
 * Returns `null` for anything malformed or out of range, so callers can decide
 * how to report the failure instead of catching (used at the FormData
 * boundary in `lib/domain/validation.ts`).
 */
export function parseHHMM(value: string): number | null {
  const match = HHMM_PATTERN.exec(value.trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null

  return hours * 60 + minutes
}

/** Format minutes from midnight as a zero-padded `"HH:MM"` clock time. */
export function formatHHMM(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60)
  const minutes = minuteOfDay % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

/** Whether a value is a valid minute-of-day (integer, 0–1439). */
export function isMinuteOfDay(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MINUTE_OF_DAY
}

/** Length of a range in minutes. Negative when the range is reversed. */
export function durationMin(startMin: number, endMin: number): number {
  return endMin - startMin
}

/**
 * Whether two ranges intersect with positive length.
 *
 * Touching endpoints (one range ending exactly where the other starts) are
 * NOT an overlap — back-to-back blocks are legal on the timeline.
 */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin
}

/** Whether `inner` falls entirely within `outer` (shared endpoints allowed). */
export function rangeContains(outer: TimeRange, inner: TimeRange): boolean {
  return inner.startMin >= outer.startMin && inner.endMin <= outer.endMin
}

/** A window's span in minutes, accounting for a range that wraps past midnight (`endMin <= startMin`). */
export function windowSpanMin(startMin: number, endMin: number): number {
  return endMin <= startMin
    ? MINUTES_PER_DAY - startMin + endMin
    : endMin - startMin
}

/** Format a `Date`'s local time-of-day as a zero-padded `"HH:MM"` clock time. */
export function formatTimeOfDate(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/** A `YYYY-MM-DD` date, `days` days later (negative to go back). */
export function addDaysISO(dateISO: string, days: number): string {
  const [year, month, day] = dateISO.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + days)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** The current local calendar date as `YYYY-MM-DD`. */
export function todayISO(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
