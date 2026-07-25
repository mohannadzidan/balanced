import { asc, eq } from "drizzle-orm"

import { db } from "@/lib/db"
import { activityTable, ruleTable, timelineActivityTable, timelineTable } from "@/lib/db/schema"
import type { WindowRuleConfig } from "@/lib/rules/types"
import { addDaysISO } from "@/lib/time"
import { weekdayOf } from "@/lib/weekdays"

export type TimelineActivityView = {
  id: string
  title: string
  startTime: Date
  endTime: Date
  status: string
}

function dateAtMinute(dateISO: string, minuteOfDay: number): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  date.setMinutes(minuteOfDay)
  return date
}

async function getOrCreateTimeline(dateISO: string): Promise<{ id: string }> {
  const [existing] = await db
    .select({ id: timelineTable.id })
    .from(timelineTable)
    .where(eq(timelineTable.date, dateISO))
  if (existing) return existing

  await db.insert(timelineTable).values({ date: dateISO }).onConflictDoNothing()

  const [row] = await db
    .select({ id: timelineTable.id })
    .from(timelineTable)
    .where(eq(timelineTable.date, dateISO))
  return row
}

/**
 * Naive placement only (Phase 04 adds the real solver): activities without a
 * Window Rule have no time to place and are skipped for now.
 */
async function generateTimelineActivities(timelineId: string, dateISO: string): Promise<void> {
  const [alreadyGenerated] = await db
    .select({ id: timelineActivityTable.id })
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.timelineId, timelineId))
    .limit(1)
  if (alreadyGenerated) return

  const weekday = weekdayOf(new Date(`${dateISO}T00:00:00`))

  const activities = await db
    .select({
      id: activityTable.id,
      name: activityTable.name,
      allowedDays: activityTable.allowedDays,
      isTransitionOnly: activityTable.isTransitionOnly,
    })
    .from(activityTable)
    // Transition-only activities (e.g. Commute) only ever appear via a host's
    // Sequence Rule — sequence-aware placement lands in a later phase, so for
    // now they're simply excluded from the naive standalone pass rather than
    // incorrectly floating on the timeline by themselves.
    .where(eq(activityTable.isTransitionOnly, false))

  const windowRules = await db
    .select({ activityId: ruleTable.activityId, config: ruleTable.config })
    .from(ruleTable)
    .where(eq(ruleTable.ruleType, "window"))
  const windowByActivityId = new Map(
    windowRules.map((rule) => [rule.activityId, rule.config as WindowRuleConfig])
  )

  const rowsToInsert = activities
    .filter((activity) => activity.allowedDays.includes(weekday))
    .map((activity) => ({ activity, window: windowByActivityId.get(activity.id) }))
    .filter(
      (entry): entry is { activity: (typeof activities)[number]; window: WindowRuleConfig } =>
        entry.window !== undefined
    )
    .map(({ activity, window }) => {
      // `endMin <= startMin` means the window spans midnight (e.g. Sleep,
      // 22:00 to 06:00) — the end time lands on the following calendar day.
      const spansMidnight = window.endMin <= window.startMin
      return {
        timelineId,
        sourceActivityId: activity.id,
        title: activity.name,
        startTime: dateAtMinute(dateISO, window.startMin),
        endTime: dateAtMinute(spansMidnight ? addDaysISO(dateISO, 1) : dateISO, window.endMin),
        status: "upcoming",
      }
    })

  if (rowsToInsert.length > 0) {
    await db.insert(timelineActivityTable).values(rowsToInsert)
  }
}

export async function getTodayTimelineActivities(dateISO: string): Promise<TimelineActivityView[]> {
  const timeline = await getOrCreateTimeline(dateISO)
  await generateTimelineActivities(timeline.id, dateISO)

  return db
    .select({
      id: timelineActivityTable.id,
      title: timelineActivityTable.title,
      startTime: timelineActivityTable.startTime,
      endTime: timelineActivityTable.endTime,
      status: timelineActivityTable.status,
    })
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.timelineId, timeline.id))
    .orderBy(asc(timelineActivityTable.startTime))
}
