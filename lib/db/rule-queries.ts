import { and, eq, ne } from "drizzle-orm"

import { db } from "@/lib/db"
import { activityTable, overlapAllowedGuestTable, ruleTable, trackingLedgerTable } from "@/lib/db/schema"
import type {
  ActivityRules,
  OverlapRuleConfig,
  RuleType,
  SequenceRuleConfig,
  TrackingRuleConfig,
  WindowRuleConfig,
} from "@/lib/rules/types"

export async function getActivityRules(activityId: string): Promise<ActivityRules> {
  const rows = await db
    .select()
    .from(ruleTable)
    .where(eq(ruleTable.activityId, activityId))

  const windowRow = rows.find((row) => row.ruleType === "window")
  const sequenceRow = rows.find((row) => row.ruleType === "sequence")
  const overlapRow = rows.find((row) => row.ruleType === "overlap")
  const trackingRow = rows.find((row) => row.ruleType === "tracking")

  let overlap: ActivityRules["overlap"] = null
  if (overlapRow) {
    const guests = await db
      .select({ guestActivityId: overlapAllowedGuestTable.guestActivityId })
      .from(overlapAllowedGuestTable)
      .where(eq(overlapAllowedGuestTable.ruleId, overlapRow.id))

    overlap = {
      ...(overlapRow.config as OverlapRuleConfig),
      guestActivityIds: guests.map((guest) => guest.guestActivityId),
    }
  }

  return {
    window: windowRow ? (windowRow.config as WindowRuleConfig) : null,
    sequence: sequenceRow ? (sequenceRow.config as SequenceRuleConfig) : null,
    overlap,
    tracking: trackingRow ? (trackingRow.config as TrackingRuleConfig) : null,
  }
}

export async function upsertWindowRule(
  activityId: string,
  config: WindowRuleConfig
): Promise<void> {
  await db
    .insert(ruleTable)
    .values({ activityId, ruleType: "window", config })
    .onConflictDoUpdate({
      target: [ruleTable.activityId, ruleTable.ruleType],
      set: { config },
    })
}

export async function upsertSequenceRule(
  activityId: string,
  config: SequenceRuleConfig
): Promise<void> {
  await db
    .insert(ruleTable)
    .values({ activityId, ruleType: "sequence", config })
    .onConflictDoUpdate({
      target: [ruleTable.activityId, ruleTable.ruleType],
      set: { config },
    })
}

export async function upsertOverlapRule(
  activityId: string,
  config: OverlapRuleConfig,
  guestActivityIds: string[]
): Promise<void> {
  const [row] = await db
    .insert(ruleTable)
    .values({ activityId, ruleType: "overlap", config })
    .onConflictDoUpdate({
      target: [ruleTable.activityId, ruleTable.ruleType],
      set: { config },
    })
    .returning({ id: ruleTable.id })

  await db.delete(overlapAllowedGuestTable).where(eq(overlapAllowedGuestTable.ruleId, row.id))

  if (guestActivityIds.length > 0) {
    await db.insert(overlapAllowedGuestTable).values(
      guestActivityIds.map((guestActivityId) => ({ ruleId: row.id, guestActivityId }))
    )
  }
}

/**
 * Upserts the Tracking Rule and keeps `trackingLedgerTable` in lockstep: a
 * fresh ledger row starts at the rule's own target (nothing to carry over
 * yet), and an edited rule's daily target rebases the ledger immediately
 * rather than waiting for the next lazy evaluation.
 */
export async function upsertTrackingRule(
  activityId: string,
  config: TrackingRuleConfig
): Promise<void> {
  await db
    .insert(ruleTable)
    .values({ activityId, ruleType: "tracking", config })
    .onConflictDoUpdate({
      target: [ruleTable.activityId, ruleTable.ruleType],
      set: { config },
    })

  await db
    .insert(trackingLedgerTable)
    .values({ activityId, rollingTargetMinutes: config.dailyTargetMin, rollingAchievedMinutes: 0 })
    .onConflictDoUpdate({
      target: trackingLedgerTable.activityId,
      set: { rollingTargetMinutes: config.dailyTargetMin, updatedAt: new Date() },
    })
}

export async function deleteRule(activityId: string, ruleType: RuleType): Promise<void> {
  await db
    .delete(ruleTable)
    .where(and(eq(ruleTable.activityId, activityId), eq(ruleTable.ruleType, ruleType)))

  if (ruleType === "tracking") {
    await db.delete(trackingLedgerTable).where(eq(trackingLedgerTable.activityId, activityId))
  }
}

export async function listOtherActivities(
  excludeActivityId: string
): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: activityTable.id, name: activityTable.name })
    .from(activityTable)
    .where(ne(activityTable.id, excludeActivityId))
}
