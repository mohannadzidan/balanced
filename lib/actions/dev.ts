"use server"

/** TEMPORARY dev/testing actions — see `lib/db/dev-queries.ts`. */

import { revalidatePath } from "next/cache"

import {
  resetAndRegenerateTimeline,
  seedOvernightSleepFixture,
} from "@/lib/db/dev-queries"
import { todayISO } from "@/lib/time"

export async function resetAndRegenerateTimelineAction(): Promise<void> {
  await resetAndRegenerateTimeline(todayISO())
  revalidatePath("/")
}

export async function seedOvernightSleepFixtureAction(): Promise<void> {
  await seedOvernightSleepFixture(todayISO())
  revalidatePath("/")
}
