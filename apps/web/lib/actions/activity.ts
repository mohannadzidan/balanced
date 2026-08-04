"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  createActivity,
  deleteActivity,
  updateActivity,
} from "@/lib/db/activity-queries"
import { upsertWindowRule } from "@/lib/db/rule-queries"
import { regenerateForwardTimeline } from "@/lib/db/timeline-queries"
import { parseHHMM, todayISO, windowSpanMin } from "@/lib/time"
import { WEEKDAYS } from "@/lib/weekdays"

const minuteOfDayField = z.string().transform((raw, ctx) => {
  const parsed = parseHHMM(raw)
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "Enter a valid time as HH:MM." })
    return z.NEVER
  }
  return parsed
})

/** Hours (may be decimal, e.g. "7.5") from a form field, converted to whole minutes. */
const durationHoursField = z.string().transform((raw, ctx) => {
  const hours = Number(raw.trim())
  if (!Number.isFinite(hours) || hours <= 0) {
    ctx.addIssue({
      code: "custom",
      message: "Enter a positive number of hours.",
    })
    return z.NEVER
  }
  return Math.round(hours * 60)
})

/** Minutes (whole number) from a form field for transition duration. */
const transitionDurationField = z.string().transform((raw, ctx) => {
  const minutes = Number(raw.trim())
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(minutes)) {
    ctx.addIssue({
      code: "custom",
      message: "Enter a positive whole number of minutes.",
    })
    return z.NEVER
  }
  return minutes
})

// `endMin <= startMin` is a window that spans midnight (e.g. Sleep, 22:00 to
// 06:00) — only equal start/end is rejected, as an empty, ambiguous window.
// Strict windows are a fixed placement (their own span is the length);
// Flexible windows are bounds a shorter `windowDurationMin` floats within.
const createActivitySchema = z
  .object({
    name: z.string().trim().min(1, "Name is required."),
    allowedDays: z.array(z.enum(WEEKDAYS)).min(1, "Select at least one day."),
    isTransitionOnly: z.literal("on").optional(),
    transitionDurationMin: z.string().optional(),
  })
  .and(
    z.discriminatedUnion("windowKind", [
      z.object({
        windowKind: z.literal("strict"),
        windowStartMin: minuteOfDayField,
        windowEndMin: minuteOfDayField,
      }),
      z.object({
        windowKind: z.literal("flexible"),
        windowStartMin: minuteOfDayField,
        windowEndMin: minuteOfDayField,
        windowDurationMin: durationHoursField,
      }),
    ])
  )
  .refine((data) => data.windowEndMin !== data.windowStartMin, {
    message: "Start and end time cannot be the same.",
    path: ["windowEndMin"],
  })
  .refine(
    (data) =>
      data.windowKind !== "flexible" ||
      data.windowDurationMin <=
        windowSpanMin(data.windowStartMin, data.windowEndMin),
    {
      message: "Duration can't exceed the window's span.",
      path: ["windowDurationMin"],
    }
  )
  .refine(
    (data) => {
      if (data.isTransitionOnly === "on") {
        const duration = Number(data.transitionDurationMin?.trim() ?? "")
        return Number.isInteger(duration) && duration > 0
      }
      return true
    },
    {
      message:
        "Transition duration must be a positive whole number of minutes.",
      path: ["transitionDurationMin"],
    }
  )

export type ActivityFormState = { ok: true } | { ok: false; error: string }

export async function createActivityAction(
  _prevState: ActivityFormState,
  formData: FormData
): Promise<ActivityFormState> {
  const isTransitionOnly = formData.get("isTransitionOnly") === "on"
  const windowKind = formData.get("windowKind") as "strict" | "flexible"

  const baseData = {
    name: formData.get("name"),
    allowedDays: formData.getAll("allowedDays"),
    isTransitionOnly: formData.get("isTransitionOnly") ?? undefined,
    windowKind,
    windowStartMin: formData.get("windowStartMin"),
    windowEndMin: formData.get("windowEndMin"),
    windowDurationMin: formData.get("windowDurationHours"),
    transitionDurationMin: formData.get("transitionDurationMin"),
  }

  const parsed = createActivitySchema.safeParse(baseData)

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  const transitionDurationMin = isTransitionOnly
    ? transitionDurationField.parse(formData.get("transitionDurationMin"))
    : undefined

  const activity = await createActivity({
    name: parsed.data.name,
    allowedDays: parsed.data.allowedDays,
    isTransitionOnly: parsed.data.isTransitionOnly === "on",
    transitionDurationMin,
  })

  // If it's a transition-only activity, we don't create a window rule
  // The transition duration is stored on the activity itself
  if (isTransitionOnly) {
    await regenerateForwardTimeline(todayISO())
    revalidatePath("/")
    return { ok: true }
  }

  await upsertWindowRule(
    activity.id,
    parsed.data.windowKind === "strict"
      ? {
          kind: "strict",
          startMin: parsed.data.windowStartMin,
          endMin: parsed.data.windowEndMin,
        }
      : {
          kind: "flexible",
          startMin: parsed.data.windowStartMin,
          endMin: parsed.data.windowEndMin,
          durationMin: parsed.data.windowDurationMin,
        }
  )
  await regenerateForwardTimeline(todayISO())
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
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  await updateActivity(activityId, {
    name: parsed.data.name,
    allowedDays: parsed.data.allowedDays,
    isTransitionOnly: parsed.data.isTransitionOnly === "on",
  })
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")

  return { ok: true }
}

export async function deleteActivityAction(activityId: string): Promise<void> {
  await deleteActivity(activityId)
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")
}
