/**
 * TEMPORARY dev/testing tooling — not part of the product. Remove once
 * manual testing of the generator/midnight-spanning behavior is done.
 */
import { eq } from "drizzle-orm"

import { db } from "@/lib/db"
import {
  activityTable,
  timelineActivityTable,
  timelineTable,
} from "@/lib/db/schema"
import { getOrCreateTimeline } from "@/lib/db/timeline-queries"
import { addDaysISO } from "@/lib/time"

function dateAtMinute(dateISO: string, minuteOfDay: number): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  date.setMinutes(minuteOfDay)
  return date
}

/** Seeds a synthetic overnight Sleep block (yesterday 02:00 -> today 10:00), pinned so it survives regeneration — simulates a midnight-spanning anchor ahead of Phase 09. */
export async function seedOvernightSleepFixture(
  dateISO: string
): Promise<void> {
  const timeline = await getOrCreateTimeline(dateISO)
  const yesterdayISO = addDaysISO(dateISO, -1)
  const [sleepActivity] = await db
    .select()
    .from(activityTable)
    .where(eq(activityTable.name, "Sleep"))

  await db.insert(timelineActivityTable).values({
    timelineId: timeline.id,
    sourceActivityId: sleepActivity?.id ?? null,
    title: "Sleep",
    startTime: dateAtMinute(yesterdayISO, 120),
    endTime: dateAtMinute(dateISO, 600),
    status: "upcoming",
    isPinned: true,
  })
}

/**
 * Wipes today's entire generated timeline — including pinned/completed/
 * one-off rows — then re-seeds the overnight Sleep anchor *before* the next
 * load regenerates the rest of the day, so the generator sees it as already
 * occupied/immovable and builds everything else around it (rather than also
 * placing a separate, un-anchored Sleep block).
 */
export async function resetAndRegenerateTimeline(
  dateISO: string
): Promise<void> {
  const timeline = await getOrCreateTimeline(dateISO)
  await db
    .delete(timelineActivityTable)
    .where(eq(timelineActivityTable.timelineId, timeline.id))
  await db
    .update(timelineTable)
    .set({ lastGeneratedAt: null })
    .where(eq(timelineTable.id, timeline.id))
  await seedOvernightSleepFixture(dateISO)
}
