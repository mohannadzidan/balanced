import { asc, eq } from "drizzle-orm"

import { db } from "@/lib/db"
import { timelineActivityTable, timelineTable } from "@/lib/db/schema"
import { getOrCreateTimeline, regenerateForwardTimeline } from "@/lib/db/timeline-queries"

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000)
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

type ExecutionResult = { ok: true } | { ok: false; error: string }

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
 * Records an early finish, then re-runs the resolver over the rest of
 * today (`regenerateForwardTimeline`) so the freed time is actually used —
 * a flexible activity can slide earlier into it, or a tracked activity
 * furthest behind its target can fill it (PRD stories 11-13). The finished
 * block itself is `completed`, so regeneration leaves it untouched.
 */
export async function finishActivityEarly(
  timelineActivityId: string,
  actualEndTime: Date = new Date()
): Promise<ExecutionResult> {
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
    .set({ actualStartTime, actualEndTime, status: "completed" })
    .where(eq(timelineActivityTable.id, target.id))

  const [timeline] = await db
    .select({ date: timelineTable.date })
    .from(timelineTable)
    .where(eq(timelineTable.id, target.timelineId))
  if (timeline) {
    await regenerateForwardTimeline(timeline.date)
  }

  return { ok: true }
}
