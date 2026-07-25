"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createActivity, deleteActivity, updateActivity } from "@/lib/db/activity-queries"
import { upsertWindowRule } from "@/lib/db/rule-queries"
import { parseHHMM } from "@/lib/time"
import { WEEKDAYS } from "@/lib/weekdays"

const minuteOfDayField = z.string().transform((raw, ctx) => {
  const parsed = parseHHMM(raw)
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "Enter a valid time as HH:MM." })
    return z.NEVER
  }
  return parsed
})

// `endMin <= startMin` is a window that spans midnight (e.g. Sleep, 22:00 to
// 06:00) — only equal start/end is rejected, as an empty, ambiguous window.
const createActivitySchema = z
  .object({
    name: z.string().trim().min(1, "Name is required."),
    allowedDays: z.array(z.enum(WEEKDAYS)).min(1, "Select at least one day."),
    isTransitionOnly: z.literal("on").optional(),
    windowKind: z.enum(["strict", "flexible"]),
    windowStartMin: minuteOfDayField,
    windowEndMin: minuteOfDayField,
  })
  .refine((data) => data.windowEndMin !== data.windowStartMin, {
    message: "Start and end time cannot be the same.",
    path: ["windowEndMin"],
  })

export type ActivityFormState =
  | { ok: true }
  | { ok: false; error: string }

export async function createActivityAction(
  _prevState: ActivityFormState,
  formData: FormData
): Promise<ActivityFormState> {
  const parsed = createActivitySchema.safeParse({
    name: formData.get("name"),
    allowedDays: formData.getAll("allowedDays"),
    isTransitionOnly: formData.get("isTransitionOnly") ?? undefined,
    windowKind: formData.get("windowKind"),
    windowStartMin: formData.get("windowStartMin"),
    windowEndMin: formData.get("windowEndMin"),
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }

  const activity = await createActivity({
    name: parsed.data.name,
    allowedDays: parsed.data.allowedDays,
    isTransitionOnly: parsed.data.isTransitionOnly === "on",
  })
  await upsertWindowRule(activity.id, {
    kind: parsed.data.windowKind,
    startMin: parsed.data.windowStartMin,
    endMin: parsed.data.windowEndMin,
  })
  revalidatePath("/")

  return { ok: true }
}

const updateActivityDetailsSchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  allowedDays: z.array(z.enum(WEEKDAYS)).min(1, "Select at least one day."),
  isTransitionOnly: z.literal("on").optional(),
})

export async function updateActivityDetailsAction(
  activityId: string,
  _prevState: ActivityFormState,
  formData: FormData
): Promise<ActivityFormState> {
  const parsed = updateActivityDetailsSchema.safeParse({
    name: formData.get("name"),
    allowedDays: formData.getAll("allowedDays"),
    isTransitionOnly: formData.get("isTransitionOnly") ?? undefined,
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }

  await updateActivity(activityId, {
    name: parsed.data.name,
    allowedDays: parsed.data.allowedDays,
    isTransitionOnly: parsed.data.isTransitionOnly === "on",
  })
  revalidatePath("/")

  return { ok: true }
}

export async function deleteActivityAction(activityId: string): Promise<void> {
  await deleteActivity(activityId)
  revalidatePath("/")
}
