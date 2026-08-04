"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  deleteRule,
  upsertOverlapRule,
  upsertSequenceRule,
  upsertTrackingRule,
  upsertWindowRule,
} from "@/lib/db/rule-queries"
import { removeVacationDay, setVacationDay } from "@/lib/db/tracking-queries"
import { regenerateForwardTimeline } from "@/lib/db/timeline-queries"
import { parseHHMM, todayISO, windowSpanMin } from "@/lib/time"
import { NONE_OPTION } from "@/lib/rules/constants"
import type { RuleType } from "@/lib/rules/types"

export type RuleFormState = { ok: true } | { ok: false; error: string }

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

// `endMin <= startMin` is a window that spans midnight (e.g. Sleep, 22:00 to
// 06:00) — only equal start/end is rejected, as an empty, ambiguous window.
// Strict windows are a fixed placement (their own span is the length);
// Flexible windows are bounds a shorter `durationMin` floats within.
const windowRuleSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("strict"),
      startMin: minuteOfDayField,
      endMin: minuteOfDayField,
    }),
    z.object({
      kind: z.literal("flexible"),
      startMin: minuteOfDayField,
      endMin: minuteOfDayField,
      durationMin: durationHoursField,
    }),
  ])
  .refine((data) => data.endMin !== data.startMin, {
    message: "Start and end time cannot be the same.",
    path: ["endMin"],
  })
  .refine(
    (data) =>
      data.kind !== "flexible" ||
      data.durationMin <= windowSpanMin(data.startMin, data.endMin),
    {
      message: "Duration can't exceed the window's span.",
      path: ["durationMin"],
    }
  )

export async function saveWindowRuleAction(
  activityId: string,
  _prevState: RuleFormState,
  formData: FormData
): Promise<RuleFormState> {
  const parsed = windowRuleSchema.safeParse({
    kind: formData.get("kind"),
    startMin: formData.get("startMin"),
    endMin: formData.get("endMin"),
    durationMin: formData.get("durationHours"),
  })

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  await upsertWindowRule(activityId, parsed.data)
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")

  return { ok: true }
}

const sequenceRuleSchema = z.object({
  preActivityId: z
    .string()
    .transform((value) =>
      value === NONE_OPTION || value.trim() === "" ? null : value
    ),
  postActivityId: z
    .string()
    .transform((value) =>
      value === NONE_OPTION || value.trim() === "" ? null : value
    ),
})

export async function saveSequenceRuleAction(
  activityId: string,
  _prevState: RuleFormState,
  formData: FormData
): Promise<RuleFormState> {
  const parsed = sequenceRuleSchema.safeParse({
    preActivityId: formData.get("preActivityId") ?? NONE_OPTION,
    postActivityId: formData.get("postActivityId") ?? NONE_OPTION,
  })

  if (!parsed.success) {
    return { ok: false, error: "Invalid input." }
  }

  await upsertSequenceRule(activityId, parsed.data)
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")

  return { ok: true }
}

const overlapRuleSchema = z.object({
  budgetMin: z
    .string()
    .transform((raw, ctx) => {
      const value = raw.trim()
      if (!/^\d+$/.test(value)) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a whole number of minutes.",
        })
        return z.NEVER
      }
      return Number(value)
    })
    .pipe(z.number().int().nonnegative()),
  guestActivityIds: z.array(z.string()),
})

export async function saveOverlapRuleAction(
  activityId: string,
  _prevState: RuleFormState,
  formData: FormData
): Promise<RuleFormState> {
  const parsed = overlapRuleSchema.safeParse({
    budgetMin: formData.get("budgetMin"),
    guestActivityIds: formData.getAll("guestActivityIds"),
  })

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  await upsertOverlapRule(
    activityId,
    { budgetMin: parsed.data.budgetMin },
    parsed.data.guestActivityIds
  )
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")

  return { ok: true }
}

const trackingRuleSchema = z.object({
  dailyTargetMin: z.string().transform((raw, ctx) => {
    const value = raw.trim()
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "Enter a positive whole number of minutes.",
      })
      return z.NEVER
    }
    return Number(value)
  }),
  minBlockMinutes: z.string().transform((raw, ctx) => {
    const value = raw.trim()
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "Enter a positive whole number of minutes.",
      })
      return z.NEVER
    }
    return Number(value)
  }),
  capMin: z.string().transform((raw, ctx) => {
    const value = raw.trim()
    if (value === "") return null
    if (!/^\d+$/.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: "Enter a whole number of minutes, or leave blank.",
      })
      return z.NEVER
    }
    return Number(value)
  }),
  carryOverEnabled: z.literal("on").optional(),
})

export async function saveTrackingRuleAction(
  activityId: string,
  _prevState: RuleFormState,
  formData: FormData
): Promise<RuleFormState> {
  const parsed = trackingRuleSchema.safeParse({
    dailyTargetMin: formData.get("dailyTargetMin"),
    minBlockMinutes: formData.get("minBlockMinutes"),
    capMin: formData.get("capMin"),
    carryOverEnabled: formData.get("carryOverEnabled") ?? undefined,
  })

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  if (
    parsed.data.capMin !== null &&
    parsed.data.capMin < parsed.data.dailyTargetMin
  ) {
    return { ok: false, error: "The cap can't be lower than the daily target." }
  }

  await upsertTrackingRule(activityId, {
    dailyTargetMin: parsed.data.dailyTargetMin,
    minBlockMinutes: parsed.data.minBlockMinutes,
    capMin: parsed.data.capMin,
    carryOverEnabled: parsed.data.carryOverEnabled === "on",
  })
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")

  return { ok: true }
}

export async function deleteRuleAction(
  activityId: string,
  ruleType: RuleType
): Promise<void> {
  await deleteRule(activityId, ruleType)
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")
}

const vacationDaySchema = z
  .string()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: "Enter a valid date.",
  })

export async function addVacationDayAction(
  activityId: string,
  vacationDateISO: string
): Promise<void> {
  const parsed = vacationDaySchema.safeParse(vacationDateISO)
  if (!parsed.success) return
  await setVacationDay(activityId, parsed.data)
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")
}

export async function removeVacationDayAction(
  activityId: string,
  vacationDateISO: string
): Promise<void> {
  await removeVacationDay(activityId, vacationDateISO)
  await regenerateForwardTimeline(todayISO())
  revalidatePath("/")
}
