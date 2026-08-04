"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { manualScheduleActivity } from "@/lib/db/manual-queries"
import { placeGuestActivity } from "@/lib/db/overlap-queries"
import { parseHHMM, todayISO } from "@/lib/time"

export type ManualFormState = { ok: true } | { ok: false; error: string }

function dateAtMinute(dateISO: string, minuteOfDay: number): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  date.setMinutes(minuteOfDay)
  return date
}

const minuteOfDayField = z.string().transform((raw, ctx) => {
  const parsed = parseHHMM(raw)
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "Enter a valid time as HH:MM." })
    return z.NEVER
  }
  return parsed
})

const manualScheduleSchema = z
  .object({
    activityId: z.string().trim().min(1, "Select an activity."),
    startMin: minuteOfDayField,
    endMin: minuteOfDayField,
  })
  .refine((data) => data.endMin > data.startMin, {
    message: "End time must be after start time.",
    path: ["endMin"],
  })

export async function manualScheduleActivityAction(
  activityId: string,
  _prevState: ManualFormState,
  formData: FormData
): Promise<ManualFormState> {
  const parsed = manualScheduleSchema.safeParse({
    activityId,
    startMin: formData.get("startMin"),
    endMin: formData.get("endMin"),
  })

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  const result = await manualScheduleActivity({
    dateISO: todayISO(),
    activityId: parsed.data.activityId,
    startMin: parsed.data.startMin,
    endMin: parsed.data.endMin,
  })
  revalidatePath("/")
  return result
}

const manualGuestSchema = z
  .object({
    guestActivityId: z.string().trim().min(1, "Select an activity."),
    startMin: minuteOfDayField,
    endMin: minuteOfDayField,
  })
  .refine((data) => data.endMin > data.startMin, {
    message: "End time must be after start time.",
    path: ["endMin"],
  })

export async function manualPlaceGuestActivityAction(
  hostTimelineActivityId: string,
  _prevState: ManualFormState,
  formData: FormData
): Promise<ManualFormState> {
  const parsed = manualGuestSchema.safeParse({
    guestActivityId: formData.get("guestActivityId"),
    startMin: formData.get("startMin"),
    endMin: formData.get("endMin"),
  })

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  const dateISO = todayISO()
  const result = await placeGuestActivity({
    hostTimelineActivityId,
    guestActivityId: parsed.data.guestActivityId,
    startTime: dateAtMinute(dateISO, parsed.data.startMin),
    endTime: dateAtMinute(dateISO, parsed.data.endMin),
  })
  revalidatePath("/")
  return result
}
