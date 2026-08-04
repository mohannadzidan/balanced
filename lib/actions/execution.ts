"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  createOneOffActivity,
  extendActivity,
  finishActivityEarly,
  pullActivityEarlier,
  startQuickActivity,
  togglePinned,
  type FinishEarlyResult,
} from "@/lib/db/execution-queries"
import { parseHHMM, todayISO } from "@/lib/time"

export type {
  FinishEarlyOption,
  FinishEarlyPrompt,
  FinishEarlyResult,
} from "@/lib/db/execution-queries"

export type ExecutionFormState = { ok: true } | { ok: false; error: string }

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

const oneOffSchema = z
  .object({
    title: z.string().trim().min(1, "Name is required."),
    startMin: minuteOfDayField,
    endMin: minuteOfDayField,
  })
  .refine((data) => data.endMin > data.startMin, {
    message: "End time must be after start time.",
    path: ["endMin"],
  })

export async function createOneOffActivityAction(
  _prevState: ExecutionFormState,
  formData: FormData
): Promise<ExecutionFormState> {
  const parsed = oneOffSchema.safeParse({
    title: formData.get("title"),
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
  const result = await createOneOffActivity({
    dateISO,
    title: parsed.data.title,
    startTime: dateAtMinute(dateISO, parsed.data.startMin),
    endTime: dateAtMinute(dateISO, parsed.data.endMin),
  })
  if (!result.ok) return result

  revalidatePath("/")
  return { ok: true }
}

export async function finishEarlyAction(
  timelineActivityId: string
): Promise<FinishEarlyResult> {
  const result = await finishActivityEarly(timelineActivityId)
  revalidatePath("/")
  return result
}

/** Accepts the Finish Early prompt's "pull the next block forward" option. */
export async function acceptPullNextAction(
  timelineActivityId: string,
  newStartIso: string
): Promise<ExecutionFormState> {
  const result = await pullActivityEarlier(
    timelineActivityId,
    new Date(newStartIso)
  )
  revalidatePath("/")
  return result
}

/** Accepts the Finish Early prompt's "start some other activity now" option. */
export async function acceptStartNewAction(input: {
  activityId: string
  startIso: string
  durationMin: number
}): Promise<ExecutionFormState> {
  const result = await startQuickActivity({
    dateISO: todayISO(),
    activityId: input.activityId,
    startTime: new Date(input.startIso),
    durationMin: input.durationMin,
  })
  revalidatePath("/")
  return result
}

export async function extendActivityAction(
  timelineActivityId: string,
  extraMinutes = 15
): Promise<ExecutionFormState> {
  const result = await extendActivity(timelineActivityId, extraMinutes)
  revalidatePath("/")
  return result
}

export async function togglePinAction(
  timelineActivityId: string
): Promise<void> {
  await togglePinned(timelineActivityId)
  revalidatePath("/")
}
