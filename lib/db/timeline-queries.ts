import { and, asc, eq, isNotNull, ne } from "drizzle-orm"

import { db } from "@/lib/db"
import {
  activityTable,
  ruleTable,
  timelineActivityTable,
  timelineRuleTable,
  timelineTable,
} from "@/lib/db/schema"
import { evaluateAndAdvanceLedger } from "@/lib/db/tracking-queries"
import type {
  OverlapRuleConfig,
  SequenceRuleConfig,
  TrackingRuleConfig,
  WindowRuleConfig,
} from "@/lib/rules/types"
import { freeGaps } from "@/lib/solver/gaps"
import { fillTrackedActivity, placeFlexibleBlock } from "@/lib/solver/placement"
import { addDaysISO, formatHHMM, type TimeRange } from "@/lib/time"
import { weekdayOf } from "@/lib/weekdays"

export type TimelineActivityView = {
  id: string
  sourceActivityId: string | null
  title: string
  startTime: Date
  endTime: Date
  status: string
  isPinned: boolean
  warningMessage: string | null
}

function dateAtMinute(dateISO: string, minuteOfDay: number): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  date.setMinutes(minuteOfDay)
  return date
}

/** `date`'s offset from `dayStart` in minutes, clamped into `[0, 1440]` (today's occupied-range bookkeeping only cares about today's portion). */
function minuteOfDayClamped(date: Date, dayStart: Date): number {
  const diffMin = Math.round((date.getTime() - dayStart.getTime()) / 60_000)
  return Math.max(0, Math.min(1440, diffMin))
}

/** A strict window's own end, clamped into today for occupied-range bookkeeping (midnight-spanning overflow is Phase 09's concern). */
function clampedEndMin(window: WindowRuleConfig): number {
  return window.endMin <= window.startMin ? 1440 : window.endMin
}

async function getOrCreateTimeline(
  dateISO: string
): Promise<{ id: string; lastGeneratedAt: Date | null }> {
  const [existing] = await db
    .select({
      id: timelineTable.id,
      lastGeneratedAt: timelineTable.lastGeneratedAt,
    })
    .from(timelineTable)
    .where(eq(timelineTable.date, dateISO))
  if (existing) return existing

  await db.insert(timelineTable).values({ date: dateISO }).onConflictDoNothing()

  const [row] = await db
    .select({
      id: timelineTable.id,
      lastGeneratedAt: timelineTable.lastGeneratedAt,
    })
    .from(timelineTable)
    .where(eq(timelineTable.date, dateISO))
  return row
}

type NewTimelineRow = {
  timelineId: string
  sourceActivityId: string
  title: string
  startTime: Date
  endTime: Date
  status: string
  warningMessage?: string
}

/**
 * The daily generator (PRD §2): strict blocks are placed first as an
 * immovable skeleton (with their Sequence Rule pre/post transitions riding
 * adjacent to them), then flexible preferred-window activities are placed
 * best-effort, then tracked activities fill whatever gaps remain,
 * prioritized by how far behind their rolling target they are.
 *
 * Re-entrant by design: any row already on the timeline (completed, pinned,
 * one-off, or a manually placed guest — see `regenerateForwardTimeline`,
 * which deletes everything else before calling this) is treated as already
 * occupying its slot rather than being re-placed from scratch, so a
 * template edit can safely regenerate "the rest of today" around it.
 */
async function generateTimelineActivities(
  timeline: { id: string; lastGeneratedAt: Date | null },
  dateISO: string
): Promise<void> {
  if (timeline.lastGeneratedAt !== null) return
  const timelineId = timeline.id

  const existingRows = await db
    .select()
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.timelineId, timelineId))

  const dayStart = dateAtMinute(dateISO, 0)
  const occupied: TimeRange[] = []
  const alreadyScheduledMinutes = new Map<string, number>()
  const activitiesWithSurvivingRow = new Set<string>()
  for (const row of existingRows) {
    const startMin = minuteOfDayClamped(row.startTime, dayStart)
    const endMin = minuteOfDayClamped(row.endTime, dayStart)
    if (endMin > startMin) occupied.push({ startMin, endMin })
    if (row.sourceActivityId) {
      alreadyScheduledMinutes.set(
        row.sourceActivityId,
        (alreadyScheduledMinutes.get(row.sourceActivityId) ?? 0) +
          Math.max(0, endMin - startMin)
      )
      // A row that started before today (a midnight-spanning carryover, e.g.
      // last night's Sleep overflowing into this morning) still blocks that
      // time and counts toward the day's total, but it's a *different*
      // occurrence from today's own — it must not stop a fresh block for
      // this same activity from being placed later today.
      if (row.startTime >= dayStart) {
        activitiesWithSurvivingRow.add(row.sourceActivityId)
      }
    }
  }

  const weekday = weekdayOf(new Date(`${dateISO}T00:00:00`))

  const activities = await db
    .select({
      id: activityTable.id,
      name: activityTable.name,
      allowedDays: activityTable.allowedDays,
      isTransitionOnly: activityTable.isTransitionOnly,
    })
    .from(activityTable)

  const activityById = new Map(
    activities.map((activity) => [activity.id, activity])
  )

  const rules = await db.select().from(ruleTable)
  const windowByActivityId = new Map<string, WindowRuleConfig>()
  const sequenceByActivityId = new Map<string, SequenceRuleConfig>()
  const overlapByActivityId = new Map<string, OverlapRuleConfig>()
  const trackingByActivityId = new Map<string, TrackingRuleConfig>()
  for (const rule of rules) {
    if (rule.ruleType === "window")
      windowByActivityId.set(rule.activityId, rule.config as WindowRuleConfig)
    if (rule.ruleType === "sequence")
      sequenceByActivityId.set(
        rule.activityId,
        rule.config as SequenceRuleConfig
      )
    if (rule.ruleType === "overlap")
      overlapByActivityId.set(rule.activityId, rule.config as OverlapRuleConfig)
    if (rule.ruleType === "tracking")
      trackingByActivityId.set(
        rule.activityId,
        rule.config as TrackingRuleConfig
      )
  }

  const todaysActivities = activities.filter(
    (activity) =>
      !activity.isTransitionOnly && activity.allowedDays.includes(weekday)
  )

  const strictHosts = todaysActivities.filter(
    (activity) =>
      !activitiesWithSurvivingRow.has(activity.id) &&
      windowByActivityId.get(activity.id)?.kind === "strict"
  )
  const strictIds = new Set(strictHosts.map((activity) => activity.id))

  const tracked = todaysActivities.filter(
    (activity) =>
      !strictIds.has(activity.id) && trackingByActivityId.has(activity.id)
  )
  const trackedIds = new Set(tracked.map((activity) => activity.id))

  const flexiblePreferred = todaysActivities.filter(
    (activity) =>
      !strictIds.has(activity.id) &&
      !trackedIds.has(activity.id) &&
      !activitiesWithSurvivingRow.has(activity.id) &&
      windowByActivityId.get(activity.id)?.kind === "flexible"
  )

  const rows: NewTimelineRow[] = []
  // Hosts (by their activityId) that need an overlap-rule clone once their row lands.
  const hostsNeedingOverlapClone: { activityId: string; rowIndex: number }[] =
    []

  function placeTransition(activityId: string, range: TimeRange) {
    const activity = activityById.get(activityId)
    if (!activity) return
    occupied.push(range)
    rows.push({
      timelineId,
      sourceActivityId: activityId,
      title: activity.name,
      startTime: dateAtMinute(dateISO, range.startMin),
      endTime: dateAtMinute(dateISO, range.endMin),
      status: "upcoming",
    })
  }

  // 1. Strict skeleton + adjacent Sequence Rule transitions.
  for (const host of strictHosts) {
    const window = windowByActivityId.get(host.id)!
    const hostStart = window.startMin
    const hostEnd = clampedEndMin(window)

    occupied.push({ startMin: hostStart, endMin: hostEnd })
    rows.push({
      timelineId,
      sourceActivityId: host.id,
      title: host.name,
      startTime: dateAtMinute(dateISO, hostStart),
      endTime:
        window.endMin <= window.startMin
          ? addDaysMinuteRollover(dateISO, window.endMin)
          : dateAtMinute(dateISO, window.endMin),
      status: "upcoming",
    })
    if (overlapByActivityId.has(host.id)) {
      hostsNeedingOverlapClone.push({
        activityId: host.id,
        rowIndex: rows.length - 1,
      })
    }

    const sequence = sequenceByActivityId.get(host.id)
    if (sequence?.preActivityId) {
      const preWindow = windowByActivityId.get(sequence.preActivityId)
      if (preWindow) {
        const duration = clampedEndMin(preWindow) - preWindow.startMin
        if (duration > 0) {
          const endMin = hostStart
          const startMin = Math.max(0, endMin - duration)
          if (endMin > startMin)
            placeTransition(sequence.preActivityId, { startMin, endMin })
        }
      }
    }
    if (sequence?.postActivityId) {
      const postWindow = windowByActivityId.get(sequence.postActivityId)
      if (postWindow) {
        const duration = clampedEndMin(postWindow) - postWindow.startMin
        if (duration > 0) {
          const startMin = hostEnd
          const endMin = Math.min(1440, startMin + duration)
          if (endMin > startMin)
            placeTransition(sequence.postActivityId, { startMin, endMin })
        }
      }
    }
  }

  // 2. Flexible preferred-window activities, best-effort.
  for (const activity of flexiblePreferred) {
    const window = windowByActivityId.get(activity.id)!
    if (window.kind !== "flexible") continue // filter above guarantees this; narrows the type
    const clampedWindow = {
      startMin: window.startMin,
      endMin: clampedEndMin(window),
    }
    // Runtime-defensive: `config` is unchecked JSON, so a pre-existing row saved
    // before `durationMin` existed falls back to the window's own full span.
    const durationMin =
      typeof window.durationMin === "number"
        ? window.durationMin
        : clampedWindow.endMin - clampedWindow.startMin
    const spansMidnight = window.endMin <= window.startMin

    if (spansMidnight) {
      // e.g. Sleep, 21:00-07:00: nothing else can occupy tomorrow's minutes
      // yet, so the only contested resource is today's run up to midnight.
      // Find where that run starts (the latest gap that reaches all the way
      // to 24:00) and let the block run its full duration past it, into
      // tomorrow, rather than clamping/shrinking it to fit before midnight.
      const runToMidnight = freeGaps(occupied).find(
        (gap) => gap.endMin === 1440 && gap.startMin < 1440
      )
      if (!runToMidnight) continue // midnight itself is already claimed by something else today
      const startMin = Math.max(runToMidnight.startMin, window.startMin)
      if (startMin >= 1440) continue

      occupied.push({ startMin, endMin: 1440 })
      const overflowMin = startMin + durationMin - 1440
      rows.push({
        timelineId,
        sourceActivityId: activity.id,
        title: activity.name,
        startTime: dateAtMinute(dateISO, startMin),
        endTime:
          overflowMin > 0
            ? addDaysMinuteRollover(dateISO, overflowMin)
            : dateAtMinute(dateISO, startMin + durationMin),
        status: "upcoming",
        warningMessage:
          startMin > window.startMin
            ? `Pushed later — starts at ${formatHHMM(startMin)} instead of its preferred start.`
            : undefined,
      })
      continue
    }

    const result = placeFlexibleBlock(
      clampedWindow,
      durationMin,
      freeGaps(occupied)
    )
    if (!result) continue
    occupied.push(result.block)
    rows.push({
      timelineId,
      sourceActivityId: activity.id,
      title: activity.name,
      startTime: dateAtMinute(dateISO, result.block.startMin),
      endTime: dateAtMinute(dateISO, result.block.endMin),
      status: "upcoming",
      warningMessage: result.wasShrunk
        ? `Shrunk to fit — wanted ${durationMin}m, got ${result.block.endMin - result.block.startMin}m.`
        : undefined,
    })
  }

  // 3. Tracked activities fill remaining gaps, furthest-behind first. Minutes
  // already logged today via a surviving (pinned/completed) row count against
  // the target, so a regeneration tops up rather than double-scheduling.
  const trackedWithTargets = await Promise.all(
    tracked.map(async (activity) => {
      const config = trackingByActivityId.get(activity.id)!
      const fullTargetMin = await evaluateAndAdvanceLedger(
        activity.id,
        config,
        dateISO
      )
      const targetMin = Math.max(
        0,
        fullTargetMin - (alreadyScheduledMinutes.get(activity.id) ?? 0)
      )
      return { activity, config, targetMin }
    })
  )
  trackedWithTargets.sort((a, b) => b.targetMin - a.targetMin)

  for (const { activity, config, targetMin } of trackedWithTargets) {
    if (targetMin <= 0) continue
    const window = windowByActivityId.get(activity.id) ?? null
    const { placements, shortfallMin } = fillTrackedActivity({
      targetMin,
      minBlockMin: config.minBlockMinutes,
      window,
      gaps: freeGaps(occupied),
    })

    placements.forEach((placement, index) => {
      occupied.push(placement)
      const isLast = index === placements.length - 1
      rows.push({
        timelineId,
        sourceActivityId: activity.id,
        title: activity.name,
        startTime: dateAtMinute(dateISO, placement.startMin),
        endTime: dateAtMinute(dateISO, placement.endMin),
        status: "upcoming",
        warningMessage:
          isLast && shortfallMin > 0
            ? `${shortfallMin}m of today's ${targetMin}m target couldn't be scheduled.`
            : undefined,
      })
    })
  }

  if (rows.length > 0) {
    const inserted = await db
      .insert(timelineActivityTable)
      .values(rows)
      .returning({ id: timelineActivityTable.id })

    for (const { activityId, rowIndex } of hostsNeedingOverlapClone) {
      const overlap = overlapByActivityId.get(activityId)
      if (!overlap) continue
      await db.insert(timelineRuleTable).values({
        timelineActivityId: inserted[rowIndex].id,
        ruleType: "overlap",
        config: overlap,
      })
    }
  }

  await db
    .update(timelineTable)
    .set({ lastGeneratedAt: new Date() })
    .where(eq(timelineTable.id, timelineId))
}

/** `endMin` on a window that spans midnight, expressed as a minute-of-day on the following calendar day (via `addDaysISO`). */
function addDaysMinuteRollover(dateISO: string, endMin: number): Date {
  return dateAtMinute(addDaysISO(dateISO, 1), endMin)
}

export async function getTodayTimelineActivities(
  dateISO: string
): Promise<TimelineActivityView[]> {
  const timeline = await getOrCreateTimeline(dateISO)
  await generateTimelineActivities(timeline, dateISO)

  return db
    .select({
      id: timelineActivityTable.id,
      sourceActivityId: timelineActivityTable.sourceActivityId,
      title: timelineActivityTable.title,
      startTime: timelineActivityTable.startTime,
      endTime: timelineActivityTable.endTime,
      status: timelineActivityTable.status,
      isPinned: timelineActivityTable.isPinned,
      warningMessage: timelineActivityTable.warningMessage,
    })
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.timelineId, timeline.id))
    .orderBy(asc(timelineActivityTable.startTime))
}

/**
 * Re-runs the resolver over today's still-upcoming schedule after an
 * activity/rule edit. Completed blocks, pinned blocks, and one-off events
 * (`sourceActivityId IS NULL`) are left untouched; everything else that was
 * template-derived and not yet finished is cleared and regenerated from the
 * activities/rules as they now stand. A no-op if today's timeline hasn't
 * been generated yet — the next visit generates it fresh anyway.
 */
export async function regenerateForwardTimeline(
  dateISO: string
): Promise<void> {
  const [timeline] = await db
    .select({ id: timelineTable.id })
    .from(timelineTable)
    .where(eq(timelineTable.date, dateISO))
  if (!timeline) return

  await db
    .delete(timelineActivityTable)
    .where(
      and(
        eq(timelineActivityTable.timelineId, timeline.id),
        ne(timelineActivityTable.status, "completed"),
        eq(timelineActivityTable.isPinned, false),
        isNotNull(timelineActivityTable.sourceActivityId)
      )
    )

  await generateTimelineActivities(
    { id: timeline.id, lastGeneratedAt: null },
    dateISO
  )
}

export { getOrCreateTimeline }
