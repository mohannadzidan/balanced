import { eq, inArray } from "drizzle-orm"

import { db } from "@/lib/db"
import {
  activityTable,
  timelineActivityTable,
  timelineOverlapGuestTable,
  timelineRuleTable,
} from "@/lib/db/schema"
import { getActivityRules } from "@/lib/db/rule-queries"
import type { OverlapRuleConfig } from "@/lib/rules/types"

function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000)
}

/** Which timeline activities are guests, and which host each belongs to — for nested rendering. */
export async function getGuestLinks(
  timelineId: string
): Promise<{ guestIdToHostId: Map<string, string>; hostIdToGuestIds: Map<string, string[]> }> {
  const rows = await db
    .select({
      guestId: timelineOverlapGuestTable.timelineGuestActivityId,
      hostId: timelineRuleTable.timelineActivityId,
    })
    .from(timelineOverlapGuestTable)
    .innerJoin(timelineRuleTable, eq(timelineRuleTable.id, timelineOverlapGuestTable.timelineRuleId))
    .innerJoin(timelineActivityTable, eq(timelineActivityTable.id, timelineOverlapGuestTable.timelineGuestActivityId))
    .where(eq(timelineActivityTable.timelineId, timelineId))

  const guestIdToHostId = new Map(rows.map((row) => [row.guestId, row.hostId]))
  const hostIdToGuestIds = new Map<string, string[]>()
  for (const row of rows) {
    const list = hostIdToGuestIds.get(row.hostId) ?? []
    list.push(row.guestId)
    hostIdToGuestIds.set(row.hostId, list)
  }
  return { guestIdToHostId, hostIdToGuestIds }
}

export type OverlapBudget = { ruleId: string; budgetMin: number; remainingMin: number }

/** The host's cloned Overlap Rule and how much of its budget is still unspent. */
export async function getOverlapBudgetForHost(hostTimelineActivityId: string): Promise<OverlapBudget | null> {
  const [rule] = await db
    .select()
    .from(timelineRuleTable)
    .where(eq(timelineRuleTable.timelineActivityId, hostTimelineActivityId))
  if (!rule || rule.ruleType !== "overlap") return null

  const config = rule.config as OverlapRuleConfig
  const links = await db
    .select({ guestId: timelineOverlapGuestTable.timelineGuestActivityId })
    .from(timelineOverlapGuestTable)
    .where(eq(timelineOverlapGuestTable.timelineRuleId, rule.id))

  let usedMin = 0
  if (links.length > 0) {
    const guestRows = await db
      .select({ startTime: timelineActivityTable.startTime, endTime: timelineActivityTable.endTime })
      .from(timelineActivityTable)
      .where(inArray(timelineActivityTable.id, links.map((link) => link.guestId)))
    usedMin = guestRows.reduce((sum, row) => sum + minutesBetween(row.startTime, row.endTime), 0)
  }

  return { ruleId: rule.id, budgetMin: config.budgetMin, remainingMin: Math.max(0, config.budgetMin - usedMin) }
}

type ExecutionResult = { ok: true } | { ok: false; error: string }

/** Places a real, persisted guest block inside a host's overlap budget (manual or spare-time-prompt driven). */
export async function placeGuestActivity(input: {
  hostTimelineActivityId: string
  guestActivityId: string
  startTime: Date
  endTime: Date
}): Promise<ExecutionResult> {
  if (input.endTime <= input.startTime) {
    return { ok: false, error: "End time must be after start time." }
  }

  const budget = await getOverlapBudgetForHost(input.hostTimelineActivityId)
  if (!budget) return { ok: false, error: "This host has no Overlap Rule." }

  const durationMin = minutesBetween(input.startTime, input.endTime)
  if (durationMin > budget.remainingMin) {
    return { ok: false, error: `Only ${budget.remainingMin}m of overlap budget remains.` }
  }

  const [host] = await db
    .select()
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.id, input.hostTimelineActivityId))
  if (!host) return { ok: false, error: "Host not found." }
  if (input.startTime < host.startTime || input.endTime > host.endTime) {
    return { ok: false, error: "Must fall within the host's time span." }
  }

  const [activity] = await db.select().from(activityTable).where(eq(activityTable.id, input.guestActivityId))
  if (!activity) return { ok: false, error: "Guest activity not found." }

  const [guestRow] = await db
    .insert(timelineActivityTable)
    .values({
      timelineId: host.timelineId,
      sourceActivityId: activity.id,
      title: activity.name,
      startTime: input.startTime,
      endTime: input.endTime,
      status: "upcoming",
      // A guest placed by explicit user choice (manual placement or accepting
      // a spare-time prompt) shouldn't be swept away by the next regeneration.
      isPinned: true,
    })
    .returning({ id: timelineActivityTable.id })

  await db.insert(timelineOverlapGuestTable).values({ timelineRuleId: budget.ruleId, timelineGuestActivityId: guestRow.id })

  return { ok: true }
}

export type SpareTimePrompt = {
  hostTimelineActivityId: string
  freedStartIso: string
  freedMin: number
  quickActivities: { id: string; name: string; suggestedDurationMin: number }[]
}

/**
 * Finishing a guest early banks the leftover minutes as transient state
 * (PRD §3.4 — never persisted). Returns a prompt of allowed guests whose
 * minimum duration fits the freed time, or `null` if there's nothing worth
 * offering.
 */
export async function finishGuestEarly(
  guestTimelineActivityId: string,
  actualEndTime: Date = new Date()
): Promise<{ ok: true; prompt: SpareTimePrompt | null } | { ok: false; error: string }> {
  const [guest] = await db
    .select()
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.id, guestTimelineActivityId))
  if (!guest) return { ok: false, error: "Activity not found." }
  if (guest.status === "completed") return { ok: false, error: "Already finished." }

  const actualStartTime = guest.actualStartTime ?? guest.startTime
  if (actualStartTime > new Date()) {
    return {
      ok: false,
      error: `Hasn't started yet — starts at ${String(actualStartTime.getHours()).padStart(2, "0")}:${String(actualStartTime.getMinutes()).padStart(2, "0")}.`,
    }
  }
  if (actualEndTime <= actualStartTime) {
    return { ok: false, error: "Finish time must be after the start time." }
  }

  await db
    .update(timelineActivityTable)
    // `endTime` moves to the real finish time so the block's displayed span
    // reflects what actually happened — `guest.endTime` below still refers to
    // the pre-update (originally scheduled) value, which is what "freed"
    // must be measured against.
    .set({ actualStartTime, actualEndTime, endTime: actualEndTime, status: "completed" })
    .where(eq(timelineActivityTable.id, guest.id))

  const freedMin = minutesBetween(actualEndTime, guest.endTime)
  if (freedMin <= 0) return { ok: true, prompt: null }

  const [link] = await db
    .select({ timelineRuleId: timelineOverlapGuestTable.timelineRuleId })
    .from(timelineOverlapGuestTable)
    .where(eq(timelineOverlapGuestTable.timelineGuestActivityId, guest.id))
  if (!link) return { ok: true, prompt: null }

  const [rule] = await db.select().from(timelineRuleTable).where(eq(timelineRuleTable.id, link.timelineRuleId))
  if (!rule) return { ok: true, prompt: null }

  const hostTimelineActivityId = rule.timelineActivityId
  const [host] = await db
    .select()
    .from(timelineActivityTable)
    .where(eq(timelineActivityTable.id, hostTimelineActivityId))
  if (!host || !host.sourceActivityId) return { ok: true, prompt: null }

  const hostRules = await getActivityRules(host.sourceActivityId)
  const guestActivityIds = hostRules.overlap?.guestActivityIds ?? []
  if (guestActivityIds.length === 0) return { ok: true, prompt: null }

  const budget = await getOverlapBudgetForHost(hostTimelineActivityId)
  const usableMin = Math.min(freedMin, budget?.remainingMin ?? 0)
  if (usableMin <= 0) return { ok: true, prompt: null }

  const candidateActivities = await db.select().from(activityTable).where(inArray(activityTable.id, guestActivityIds))
  const candidateRules = await Promise.all(candidateActivities.map((activity) => getActivityRules(activity.id)))

  const quickActivities = candidateActivities
    .map((activity, index) => {
      const rules = candidateRules[index]
      const windowDuration = rules.window
        ? rules.window.kind === "flexible"
          ? rules.window.durationMin
          : rules.window.endMin - rules.window.startMin
        : null
      const minDuration = rules.tracking?.minBlockMinutes ?? windowDuration
      if (minDuration === null || minDuration <= 0 || minDuration > usableMin) return null
      return { id: activity.id, name: activity.name, suggestedDurationMin: Math.min(minDuration, usableMin) }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)

  if (quickActivities.length === 0) return { ok: true, prompt: null }

  return {
    ok: true,
    prompt: {
      hostTimelineActivityId,
      freedStartIso: actualEndTime.toISOString(),
      freedMin: usableMin,
      quickActivities,
    },
  }
}
