import { asc, eq } from "drizzle-orm"

import { db } from "@/lib/db"
import { activityTable } from "@/lib/db/schema"
import type { Weekday } from "@/lib/weekdays"

export type ActivitySummary = {
  id: string
  name: string
  allowedDays: string[]
  isTransitionOnly: boolean
}

export async function listActivities(): Promise<ActivitySummary[]> {
  return db
    .select({
      id: activityTable.id,
      name: activityTable.name,
      allowedDays: activityTable.allowedDays,
      isTransitionOnly: activityTable.isTransitionOnly,
    })
    .from(activityTable)
    .orderBy(asc(activityTable.createdAt))
}

export async function createActivity(input: {
  name: string
  allowedDays: Weekday[]
  isTransitionOnly: boolean
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(activityTable)
    .values({
      name: input.name,
      allowedDays: input.allowedDays,
      isTransitionOnly: input.isTransitionOnly,
    })
    .returning({ id: activityTable.id })
  return row
}

export async function updateActivity(
  id: string,
  input: { name: string; allowedDays: Weekday[]; isTransitionOnly: boolean }
): Promise<void> {
  await db
    .update(activityTable)
    .set({
      name: input.name,
      allowedDays: input.allowedDays,
      isTransitionOnly: input.isTransitionOnly,
      updatedAt: new Date(),
    })
    .where(eq(activityTable.id, id))
}

export async function deleteActivity(id: string): Promise<void> {
  await db.delete(activityTable).where(eq(activityTable.id, id))
}
