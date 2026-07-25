import { and, eq } from "drizzle-orm"

import { db } from "@/lib/db"
import {
  activityTable,
  ruleTable,
  timelineActivityTable,
  timelineTable,
  trackingLedgerTable,
  vacationDayTable,
} from "@/lib/db/schema"
import type { TrackingRuleConfig } from "@/lib/rules/types"
import { addDaysISO } from "@/lib/time"
import { nextRollingTarget, nextRollingTargetNoCarryOver } from "@/lib/tracking/carryover"

export async function isVacationDay(activityId: string, dateISO: string): Promise<boolean> {
  const [row] = await db
    .select({ id: vacationDayTable.id })
    .from(vacationDayTable)
    .where(and(eq(vacationDayTable.activityId, activityId), eq(vacationDayTable.date, dateISO)))
  return row !== undefined
}

export async function listVacationDays(activityId: string): Promise<string[]> {
  const rows = await db
    .select({ date: vacationDayTable.date })
    .from(vacationDayTable)
    .where(eq(vacationDayTable.activityId, activityId))
  return rows.map((row) => row.date)
}

export async function setVacationDay(activityId: string, dateISO: string): Promise<void> {
  await db.insert(vacationDayTable).values({ activityId, date: dateISO }).onConflictDoNothing()
}

export async function removeVacationDay(activityId: string, dateISO: string): Promise<void> {
  await db
    .delete(vacationDayTable)
    .where(and(eq(vacationDayTable.activityId, activityId), eq(vacationDayTable.date, dateISO)))
}

/** Sum of actual logged minutes for one activity on one calendar date. */
export async function achievedMinutesOn(activityId: string, dateISO: string): Promise<number> {
  const [timeline] = await db
    .select({ id: timelineTable.id })
    .from(timelineTable)
    .where(eq(timelineTable.date, dateISO))
  if (!timeline) return 0

  const rows = await db
    .select({
      actualStartTime: timelineActivityTable.actualStartTime,
      actualEndTime: timelineActivityTable.actualEndTime,
    })
    .from(timelineActivityTable)
    .where(
      and(
        eq(timelineActivityTable.timelineId, timeline.id),
        eq(timelineActivityTable.sourceActivityId, activityId)
      )
    )

  return rows.reduce((total, row) => {
    if (!row.actualStartTime || !row.actualEndTime) return total
    const minutes = Math.round((row.actualEndTime.getTime() - row.actualStartTime.getTime()) / 60_000)
    return total + Math.max(0, minutes)
  }, 0)
}

/**
 * Lazily evaluates yesterday's completion against the ledger (a no-op if
 * already evaluated for `todayISO`), advances the rolling target, and
 * returns the effective target for generating today's timeline — forced to
 * 0 on a vacation day, without disturbing the persisted rolling target.
 *
 * Safe to call more than once for the same activity/date (e.g. from both
 * `Schedule` and `DailyProgress` independently) — the second call sees
 * `lastEvaluatedDate === todayISO` and only re-reads, never re-applies.
 */
export async function evaluateAndAdvanceLedger(
  activityId: string,
  trackingConfig: TrackingRuleConfig,
  todayISO: string
): Promise<number> {
  const [ledger] = await db
    .select()
    .from(trackingLedgerTable)
    .where(eq(trackingLedgerTable.activityId, activityId))

  let rollingTargetMinutes = ledger?.rollingTargetMinutes ?? trackingConfig.dailyTargetMin
  let rollingAchievedMinutes = ledger?.rollingAchievedMinutes ?? 0
  const lastEvaluatedDate = ledger?.lastEvaluatedDate ?? null

  if (lastEvaluatedDate !== todayISO) {
    if (!trackingConfig.carryOverEnabled) {
      rollingTargetMinutes = nextRollingTargetNoCarryOver(trackingConfig.dailyTargetMin, trackingConfig.capMin)
    } else {
      const yesterdayISO = addDaysISO(todayISO, -1)
      const evaluation =
        lastEvaluatedDate === null
          ? null
          : {
              achievedMin: await achievedMinutesOn(activityId, yesterdayISO),
              expectedMin: rollingTargetMinutes,
              wasVacation: await isVacationDay(activityId, yesterdayISO),
            }
      rollingTargetMinutes = nextRollingTarget({
        baseTargetMin: trackingConfig.dailyTargetMin,
        capMin: trackingConfig.capMin,
        evaluation,
      })
      rollingAchievedMinutes = evaluation?.achievedMin ?? rollingAchievedMinutes
    }

    await db
      .insert(trackingLedgerTable)
      .values({ activityId, rollingTargetMinutes, rollingAchievedMinutes, lastEvaluatedDate: todayISO })
      .onConflictDoUpdate({
        target: trackingLedgerTable.activityId,
        set: { rollingTargetMinutes, rollingAchievedMinutes, lastEvaluatedDate: todayISO, updatedAt: new Date() },
      })
  }

  return (await isVacationDay(activityId, todayISO)) ? 0 : rollingTargetMinutes
}

export type TrackingProgress = {
  activityId: string
  activityName: string
  targetMin: number
  achievedTodayMin: number
}

/** Today's effective target and logged-so-far minutes for every tracked activity. */
export async function getTrackingProgressForToday(todayISO: string): Promise<TrackingProgress[]> {
  const rows = await db
    .select({ activityId: ruleTable.activityId, activityName: activityTable.name, config: ruleTable.config })
    .from(ruleTable)
    .innerJoin(activityTable, eq(activityTable.id, ruleTable.activityId))
    .where(eq(ruleTable.ruleType, "tracking"))

  return Promise.all(
    rows.map(async (row) => {
      const config = row.config as TrackingRuleConfig
      const [targetMin, achievedTodayMin] = await Promise.all([
        evaluateAndAdvanceLedger(row.activityId, config, todayISO),
        achievedMinutesOn(row.activityId, todayISO),
      ])
      return { activityId: row.activityId, activityName: row.activityName, targetMin, achievedTodayMin }
    })
  )
}
