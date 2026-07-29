import type { Day, DayFrame, Frame, Weekday } from "./types"

const WEEKDAYS: readonly Weekday[] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function localPartsAt(timeZone: string, utcMillis: number): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
  const map: Record<string, number> = {}
  for (const part of dtf.formatToParts(new Date(utcMillis))) {
    if (part.type !== "literal") map[part.type] = Number(part.value)
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour % 24,
    minute: map.minute,
  }
}

function offsetMinutesAt(timeZone: string, utcMillis: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const map: Record<string, number> = {}
  for (const part of dtf.formatToParts(new Date(utcMillis))) {
    if (part.type !== "literal") map[part.type] = Number(part.value)
  }
  // Reconstruct the local wall-clock time as if it were UTC, including
  // seconds — dropping them here would leave up to 59s of rounding error,
  // which corrupts the offset near a DST transition boundary.
  const asUtc = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    map.hour % 24,
    map.minute,
    map.second
  )
  // Real-world zone offsets are always a whole number of minutes; rounding
  // absorbs the sub-second slop introduced when utcMillis isn't itself
  // second-aligned (e.g. a binary-search midpoint).
  return Math.round((asUtc - utcMillis) / 60_000)
}

function partsMatch(
  timeZone: string,
  utcMillis: number,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number
): boolean {
  const p = localPartsAt(timeZone, utcMillis)
  return (
    p.year === y &&
    p.month === mo &&
    p.day === d &&
    p.hour === h &&
    p.minute === mi
  )
}

export interface WallClockResolution {
  readonly instant: number
  readonly ambiguous: boolean
  readonly nonExistent: boolean
}

/**
 * Resolves a local wall-clock time in an IANA zone to a UTC instant.
 * Ambiguous times (fall-back) resolve to their first occurrence.
 * Non-existent times (spring-forward gap) resolve to the transition instant,
 * per SPEC.md Section 3.3.
 */
const HALF_DAY_MS = 12 * 60 * 60 * 1000

export function resolveWallClockToInstant(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string
): WallClockResolution {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0)

  // Sample the offset well clear of the guess on both sides. Any DST
  // transition affecting this wall-clock time lies inside this window,
  // and outside a transition the two samples always agree.
  const offsetBefore = offsetMinutesAt(timeZone, guess - HALF_DAY_MS)
  const offsetAfter = offsetMinutesAt(timeZone, guess + HALF_DAY_MS)

  if (offsetBefore === offsetAfter) {
    return {
      instant: guess - offsetBefore * 60_000,
      ambiguous: false,
      nonExistent: false,
    }
  }

  const candidateBefore = guess - offsetBefore * 60_000
  const candidateAfter = guess - offsetAfter * 60_000
  const matchBefore = partsMatch(timeZone, candidateBefore, y, mo, d, h, mi)
  const matchAfter = partsMatch(timeZone, candidateAfter, y, mo, d, h, mi)

  if (matchBefore && matchAfter) {
    return {
      instant: Math.min(candidateBefore, candidateAfter),
      ambiguous: true,
      nonExistent: false,
    }
  }
  if (matchBefore)
    return { instant: candidateBefore, ambiguous: false, nonExistent: false }
  if (matchAfter)
    return { instant: candidateAfter, ambiguous: false, nonExistent: false }

  // Neither candidate reproduces the requested wall clock: it falls inside a
  // spring-forward gap. Binary-search for the transition instant and resolve
  // to it, per spec.
  let lo = Math.min(candidateBefore, candidateAfter)
  let hi = Math.max(candidateBefore, candidateAfter)
  const loOffset = offsetMinutesAt(timeZone, lo)
  while (hi - lo > 1_000) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (offsetMinutesAt(timeZone, mid) === loOffset) {
      lo = mid
    } else {
      hi = mid
    }
  }
  // Real-world DST transitions always land on a whole minute; snap away the
  // sub-second search noise rather than reporting a spuriously precise ms.
  return {
    instant: Math.round(hi / 60_000) * 60_000,
    ambiguous: false,
    nonExistent: true,
  }
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10)
}

function buildDay(index: number, date: string, timezone: string): Day {
  const [y, mo, d] = date.split("-").map(Number)
  const start = resolveWallClockToInstant(y, mo, d, 0, 0, timezone)
  const nextDate = addDays(date, 1)
  const [ny, nmo, nd] = nextDate.split("-").map(Number)
  const end = resolveWallClockToInstant(ny, nmo, nd, 0, 0, timezone)
  return {
    index,
    date,
    weekday: weekdayOf(date),
    // Placeholder; startOffset is filled in by resolveFrame once frame.startInstant
    // is known. Day 0's offset is always 0.
    startOffset: 0,
    lengthMinutes: Math.round((end.instant - start.instant) / 60_000),
  }
}

/** The DST-correct length, in minutes, of one local calendar date in an
 * IANA timezone (SPEC-v2.1 §4: 1440 normally; 1380 / 1500 on transitions).
 * Used for midnight-spanning FixedRule resolution at frame edges where
 * `frame.days[i+1]` doesn't exist. */
export function lengthMinutesOfDate(date: string, timezone: string): number {
  return buildDay(0, date, timezone).lengthMinutes
}

/**
 * Resolves a multi-day Frame starting at a local calendar date (SPEC-v2.md
 * Section 3). `dayCount` is always 1 in Drop 1, so `days[0]` is built exactly
 * as the pre-Drop-1 `resolveDayFrame` built a `DayFrame` — local midnight to
 * local midnight, sampled from the timezone database.
 */
export function resolveFrame(
  date: string,
  dayCount: number,
  timezone: string
): Frame {
  const [y0, mo0, d0] = date.split("-").map(Number)
  const startInstant = resolveWallClockToInstant(
    y0,
    mo0,
    d0,
    0,
    0,
    timezone
  ).instant

  const days: Day[] = []
  let cursorDate = date
  let cursorOffset = 0
  for (let index = 0; index < dayCount; index++) {
    const day = buildDay(index, cursorDate, timezone)
    days.push({ ...day, startOffset: cursorOffset })
    cursorOffset += day.lengthMinutes
    cursorDate = addDays(cursorDate, 1)
  }

  const lengthMinutes = days.reduce((sum, day) => sum + day.lengthMinutes, 0)

  return {
    startDate: date,
    date,
    timezone,
    startInstant,
    dayCount,
    lengthMinutes,
    days,
  }
}

/** Resolves the day frame for a local calendar date in an IANA zone. Retained as an
 * alias of `resolveFrame(date, 1, timezone)` (SPEC-v2.md Section 3.2). */
export function resolveDayFrame(date: string, timezone: string): DayFrame {
  return resolveFrame(date, 1, timezone)
}

/**
 * Resolves an "HH:MM" wall-clock string to an offset from the start of the
 * frame, on the given day (SPEC-v2.md Section 3.1). `dayIndex` defaults to 0,
 * so with a single-day frame this is arithmetically identical to before.
 */
export function resolveWallClock(
  wall: string,
  frame: DayFrame,
  dayIndex = 0
): number {
  const day = frame.days[dayIndex]
  const [h, mi] = wall.split(":").map(Number)
  const [y, mo, d] = day.date.split("-").map(Number)
  const resolved = resolveWallClockToInstant(y, mo, d, h, mi, frame.timezone)
  const dayStartInstant = frame.startInstant + day.startOffset * 60_000
  return (
    day.startOffset + Math.round((resolved.instant - dayStartInstant) / 60_000)
  )
}

export function weekdayOf(date: string): Weekday {
  const [y, mo, d] = date.split("-").map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]
}
