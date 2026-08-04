"use server"

import { revalidatePath } from "next/cache"

import {
  finishGuestEarly,
  placeGuestActivity,
  type SpareTimePrompt,
} from "@/lib/db/overlap-queries"

export type FinishGuestResult =
  | { ok: true; prompt: SpareTimePrompt | null }
  | { ok: false; error: string }

export async function finishGuestEarlyAction(
  timelineActivityId: string
): Promise<FinishGuestResult> {
  const result = await finishGuestEarly(timelineActivityId)
  revalidatePath("/")
  return result
}

export type AcceptSpareTimeResult = { ok: true } | { ok: false; error: string }

export async function acceptSpareTimeActivityAction(input: {
  hostTimelineActivityId: string
  guestActivityId: string
  freedStartIso: string
  durationMin: number
}): Promise<AcceptSpareTimeResult> {
  const startTime = new Date(input.freedStartIso)
  const endTime = new Date(startTime.getTime() + input.durationMin * 60_000)

  const result = await placeGuestActivity({
    hostTimelineActivityId: input.hostTimelineActivityId,
    guestActivityId: input.guestActivityId,
    startTime,
    endTime,
  })
  revalidatePath("/")
  return result
}
