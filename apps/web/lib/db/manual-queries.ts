import { eq } from "drizzle-orm"

import { db } from "@/lib/db"
import {
  activityTable,
  ruleTable,
  timelineActivityTable,
} from "@/lib/db/schema"
import { getOrCreateTimeline } from "@/lib/db/timeline-queries"
import { windowContains } from "@/lib/rules/window"
import type { WindowRuleConfig } from "@/lib/rules/types"

type ManualScheduleResult = { ok: true } | { ok: false; error: string }

function dateAtMinute(dateISO: string, minuteOfDay: number): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  date.setMinutes(minuteOfDay)
  return date
}

/**
 * Manually places a Flexible/Tracked activity's block at a user-chosen slot
 * (PRD story 20), instead of leaving placement to the solver. Rejected if
 * it collides with anything already on the timeline, or falls outside a
 * Strict window. Pinned on insert — a deliberate manual placement shouldn't
 * be silently swept away by the next `regenerateForwardTimeline` run.
 */
export async function manualScheduleActivity(input: {
  dateISO: string
  activityId: string
  startMin: number
  endMin: number
}): Promise<ManualScheduleResult> {
  if (input.endMin <= input.startMin) {
    return { ok: false, error: "End time must be after start time." }
  }

  const [activity] = await db
    .select()
    .from(activityTable)
    .where(eq(activityTable.id, input.activityId))
  if (!activity) return { ok: false, error: "Activity not found." }

  const rules = await db
    .select()
    .from(ruleTable)
    .where(eq(ruleTable.activityId, input.activityId))
  const window = rules.find((rule) => rule.ruleType === "window")?.config as
    | WindowRuleConfig
    | undefined

  // Strict and Flexible windows are both hard containers: a manually chosen
  // slot can never start or end outside them, even though Flexible only
  // requires *some* position inside the bounds rather than the full span.
  if (
    window &&
    !windowContains(window, input.startMin, input.endMin - input.startMin)
  ) {
    const kindLabel = window.kind === "strict" ? "Strict Window" : "Window"
    return { ok: false, error: `Falls outside this activity's ${kindLabel}.` }
  }

  const startTime = dateAtMinute(input.dateISO, input.startMin)
  const endTime = dateAtMinute(input.dateISO, input.endMin)

  const timeline = await getOrCreateTimeline(input.dateISO)
  const existing = await db
    .select({
      startTime: timelineActivityTable.startTime,
      endTime: timelineActivityTable.endTime,
    })
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.timelineId, timeline.id))

  const conflict = existing.some(
    (row) => startTime < row.endTime && row.startTime < endTime
  )
  if (conflict) {
    return {
      ok: false,
      error: "That time overlaps an existing block on the timeline.",
    }
  }

  await db.insert(timelineActivityTable).values({
    timelineId: timeline.id,
    sourceActivityId: activity.id,
    title: activity.name,
    startTime,
    endTime,
    status: "upcoming",
    isPinned: true,
  })

  return { ok: true }
}
