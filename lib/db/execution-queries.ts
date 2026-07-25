import { asc, eq } from "drizzle-orm"

import { db } from "@/lib/db"
import { activityTable, timelineActivityTable } from "@/lib/db/schema"
import { getActivityRules } from "@/lib/db/rule-queries"
import { getOrCreateTimeline } from "@/lib/db/timeline-queries"
import { windowContains } from "@/lib/rules/window"
import { weekdayOf } from "@/lib/weekdays"

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000)
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

/** Midnight at the start of the following calendar day, in local time. */
function endOfDay(date: Date): Date {
  const end = new Date(date)
  end.setHours(24, 0, 0, 0)
  return end
}

type ExecutionResult = { ok: true } | { ok: false; error: string }

/** One quick-start choice offered by the Finish Early prompt. */
export type FinishEarlyOption =
  | { kind: "pull-next"; timelineActivityId: string; name: string; durationMin: number }
  | { kind: "start-new"; activityId: string; name: string; durationMin: number }

export type FinishEarlyPrompt = {
  freedStartIso: string
  freedMin: number
  options: FinishEarlyOption[]
}

export type FinishEarlyResult =
  | { ok: true; prompt: FinishEarlyPrompt | null }
  | { ok: false; error: string }

/** Every block currently on a timeline, chronological by scheduled start. */
async function getTimelineRows(timelineId: string) {
  return db
    .select()
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.timelineId, timelineId))
    .orderBy(asc(timelineActivityTable.startTime))
}

export async function createOneOffActivity(input: {
  dateISO: string
  title: string
  startTime: Date
  endTime: Date
}): Promise<ExecutionResult> {
  if (input.endTime <= input.startTime) {
    return { ok: false, error: "End time must be after start time." }
  }

  const timeline = await getOrCreateTimeline(input.dateISO)
  const rows = await getTimelineRows(timeline.id)

  const conflict = rows.some((row) => input.startTime < row.endTime && row.startTime < input.endTime)
  if (conflict) {
    return { ok: false, error: "That time overlaps an existing block on the timeline." }
  }

  await db.insert(timelineActivityTable).values({
    timelineId: timeline.id,
    sourceActivityId: null,
    title: input.title,
    startTime: input.startTime,
    endTime: input.endTime,
    status: "upcoming",
  })

  return { ok: true }
}

export async function togglePinned(timelineActivityId: string): Promise<void> {
  const [row] = await db
    .select({ isPinned: timelineActivityTable.isPinned })
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.id, timelineActivityId))
  if (!row) return

  await db
    .update(timelineActivityTable)
    .set({ isPinned: !row.isPinned })
    .where(eq(timelineActivityTable.id, timelineActivityId))
}

/**
 * Extends a block by `extraMinutes`, cascading the shift onto later
 * non-pinned blocks that would otherwise overlap it (PRD story 14). Rejects
 * outright if the cascade would have to move a pinned block.
 */
export async function extendActivity(
  timelineActivityId: string,
  extraMinutes: number
): Promise<ExecutionResult> {
  const [target] = await db
    .select()
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.id, timelineActivityId))
  if (!target) return { ok: false, error: "Activity not found." }
  if (target.startTime > new Date()) {
    return { ok: false, error: `Hasn't started yet — starts at ${formatClock(target.startTime)}.` }
  }

  const rows = await getTimelineRows(target.timelineId)
  const newEnd = addMinutes(target.endTime, extraMinutes)

  const later = rows
    .filter((row) => row.id !== target.id && row.startTime >= target.endTime)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())

  const updates: { id: string; startTime: Date; endTime: Date }[] = []
  let cursorEnd = newEnd

  for (const row of later) {
    if (row.startTime >= cursorEnd) break
    if (row.isPinned) {
      return { ok: false, error: "Would overlap a pinned block." }
    }
    const shiftedStart = cursorEnd
    const shiftedEnd = addMinutes(row.endTime, minutesBetween(row.startTime, cursorEnd))
    updates.push({ id: row.id, startTime: shiftedStart, endTime: shiftedEnd })
    cursorEnd = shiftedEnd
  }

  await db
    .update(timelineActivityTable)
    .set({ endTime: newEnd })
    .where(eq(timelineActivityTable.id, target.id))

  for (const update of updates) {
    await db
      .update(timelineActivityTable)
      .set({ startTime: update.startTime, endTime: update.endTime })
      .where(eq(timelineActivityTable.id, update.id))
  }

  return { ok: true }
}

/**
 * Builds the Finish Early prompt for the gap between `actualEndTime` and
 * whatever comes next (the next upcoming block, or midnight): one option to
 * pull that next block forward into the freed time (only offered if doing so
 * wouldn't violate its own Strict window), plus one option per other
 * today-eligible activity whose rules are satisfied for starting right now
 * and whose natural/minimum duration fits the gap. `null` means nothing was
 * actually freed, or nothing eligible can fill it — the caller stays idle.
 */
async function buildFinishEarlyPrompt(
  timelineId: string,
  finishedTimelineActivityId: string,
  finishedSourceActivityId: string | null,
  actualEndTime: Date
): Promise<FinishEarlyPrompt | null> {
  const rows = await getTimelineRows(timelineId)
  const upcoming = rows
    .filter(
      (row) =>
        row.id !== finishedTimelineActivityId && row.status !== "completed" && row.startTime > actualEndTime
    )
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())

  const gapEnd = upcoming[0]?.startTime ?? endOfDay(actualEndTime)
  const freedMin = minutesBetween(actualEndTime, gapEnd)
  if (freedMin <= 0) return null

  const nowMin = minuteOfDay(actualEndTime)
  const options: FinishEarlyOption[] = []

  const nextRow = upcoming[0]
  if (nextRow) {
    const duration = minutesBetween(nextRow.startTime, nextRow.endTime)
    let eligible = true
    if (nextRow.sourceActivityId) {
      const rules = await getActivityRules(nextRow.sourceActivityId)
      if (rules.window && !windowContains(rules.window, nowMin, duration)) eligible = false
    }
    if (eligible) {
      options.push({ kind: "pull-next", timelineActivityId: nextRow.id, name: nextRow.title, durationMin: duration })
    }
  }

  // Anything already occupying a slot today (including the one that just
  // finished and the block just considered above) isn't offered again as a
  // fresh "start now" instance.
  const scheduledActivityIds = new Set(
    rows.filter((row) => row.sourceActivityId).map((row) => row.sourceActivityId as string)
  )

  const weekday = weekdayOf(actualEndTime)
  const candidates = await db
    .select({ id: activityTable.id, name: activityTable.name, allowedDays: activityTable.allowedDays })
    .from(activityTable)
    .where(eq(activityTable.isTransitionOnly, false))

  for (const candidate of candidates) {
    if (candidate.id === finishedSourceActivityId) continue
    if (scheduledActivityIds.has(candidate.id)) continue
    if (!candidate.allowedDays.includes(weekday)) continue

    const rules = await getActivityRules(candidate.id)
    const duration = rules.window
      ? rules.window.kind === "flexible"
        ? rules.window.durationMin
        : rules.window.endMin - rules.window.startMin
      : (rules.tracking?.minBlockMinutes ?? null)
    if (duration === null || duration <= 0 || duration > freedMin) continue
    if (rules.window && !windowContains(rules.window, nowMin, duration)) continue

    options.push({ kind: "start-new", activityId: candidate.id, name: candidate.name, durationMin: duration })
  }

  return options.length > 0 ? { freedStartIso: actualEndTime.toISOString(), freedMin, options } : null
}

/**
 * Records an early finish, then offers the freed gap back to the user via a
 * Finish Early prompt instead of silently auto-filling it: pull the next
 * block forward, start some other eligible activity now, or stay idle
 * (PRD stories 11-13, reframed as an explicit choice rather than automatic
 * resolver placement). The finished block itself is left untouched.
 */
export async function finishActivityEarly(
  timelineActivityId: string,
  actualEndTime: Date = new Date()
): Promise<FinishEarlyResult> {
  const [target] = await db
    .select()
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.id, timelineActivityId))
  if (!target) return { ok: false, error: "Activity not found." }
  if (target.status === "completed") return { ok: false, error: "Already finished." }

  const actualStartTime = target.actualStartTime ?? target.startTime
  if (actualStartTime > new Date()) {
    return { ok: false, error: `Hasn't started yet — starts at ${formatClock(actualStartTime)}.` }
  }
  if (actualEndTime <= actualStartTime) {
    return { ok: false, error: "Finish time must be after the start time." }
  }

  await db
    .update(timelineActivityTable)
    // `endTime` (not just `actualEndTime`) moves to the real finish time so
    // the block's displayed span — and the occupied-minutes/tracked-target
    // math a later regeneration does from `endTime` — reflect what actually
    // happened, not the original schedule.
    .set({ actualStartTime, actualEndTime, endTime: actualEndTime, status: "completed" })
    .where(eq(timelineActivityTable.id, target.id))

  const prompt = await buildFinishEarlyPrompt(target.timelineId, target.id, target.sourceActivityId, actualEndTime)
  return { ok: true, prompt }
}

/**
 * Accepts the "pull next block forward" Finish Early option: shifts that
 * block's start (and end, preserving its duration) into the freed gap. Pinned
 * on acceptance so the next regeneration doesn't move it back.
 */
export async function pullActivityEarlier(timelineActivityId: string, newStartTime: Date): Promise<ExecutionResult> {
  const [row] = await db
    .select()
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.id, timelineActivityId))
  if (!row) return { ok: false, error: "Activity not found." }
  if (row.status === "completed") return { ok: false, error: "Already finished." }

  const duration = minutesBetween(row.startTime, row.endTime)
  const newEndTime = addMinutes(newStartTime, duration)

  await db
    .update(timelineActivityTable)
    .set({ startTime: newStartTime, endTime: newEndTime, isPinned: true })
    .where(eq(timelineActivityTable.id, timelineActivityId))

  return { ok: true }
}

/**
 * Accepts a "start some other activity now" Finish Early option: inserts a
 * fresh, pinned block for it starting at the freed time.
 */
export async function startQuickActivity(input: {
  dateISO: string
  activityId: string
  startTime: Date
  durationMin: number
}): Promise<ExecutionResult> {
  const [activity] = await db.select().from(activityTable).where(eq(activityTable.id, input.activityId))
  if (!activity) return { ok: false, error: "Activity not found." }

  const timeline = await getOrCreateTimeline(input.dateISO)
  const endTime = addMinutes(input.startTime, input.durationMin)

  await db.insert(timelineActivityTable).values({
    timelineId: timeline.id,
    sourceActivityId: activity.id,
    title: activity.name,
    startTime: input.startTime,
    endTime,
    status: "upcoming",
    isPinned: true,
  })

  return { ok: true }
}
