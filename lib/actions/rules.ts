"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  deleteRule,
  upsertOverlapRule,
  upsertSequenceRule,
  upsertWindowRule,
} from "@/lib/db/rule-queries"
import { parseHHMM } from "@/lib/time"
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

// `endMin <= startMin` is a window that spans midnight (e.g. Sleep, 22:00 to
// 06:00) — only equal start/end is rejected, as an empty, ambiguous window.
const windowRuleSchema = z
  .object({
    kind: z.enum(["strict", "flexible"]),
    startMin: minuteOfDayField,
    endMin: minuteOfDayField,
  })
  .refine((data) => data.endMin !== data.startMin, {
    message: "Start and end time cannot be the same.",
    path: ["endMin"],
  })

export async function saveWindowRuleAction(
  activityId: string,
  _prevState: RuleFormState,
  formData: FormData
): Promise<RuleFormState> {
  const parsed = windowRuleSchema.safeParse({
    kind: formData.get("kind"),
    startMin: formData.get("startMin"),
    endMin: formData.get("endMin"),
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }

  await upsertWindowRule(activityId, parsed.data)
  revalidatePath("/")

  return { ok: true }
}

const sequenceRuleSchema = z.object({
  preActivityId: z
    .string()
    .transform((value) => (value === NONE_OPTION || value.trim() === "" ? null : value)),
  postActivityId: z
    .string()
    .transform((value) => (value === NONE_OPTION || value.trim() === "" ? null : value)),
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
  revalidatePath("/")

  return { ok: true }
}

const overlapRuleSchema = z.object({
  budgetMin: z
    .string()
    .transform((raw, ctx) => {
      const value = raw.trim()
      if (!/^\d+$/.test(value)) {
        ctx.addIssue({ code: "custom", message: "Enter a whole number of minutes." })
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
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }

  await upsertOverlapRule(
    activityId,
    { budgetMin: parsed.data.budgetMin },
    parsed.data.guestActivityIds
  )
  revalidatePath("/")

  return { ok: true }
}

export async function deleteRuleAction(activityId: string, ruleType: RuleType): Promise<void> {
  await deleteRule(activityId, ruleType)
  revalidatePath("/")
}
