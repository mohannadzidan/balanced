/**
 * Boundary validation for Server Action inputs.
 *
 * Constitution IV: Server Actions are the only mutation entry points, so they
 * are where untrusted input must become typed domain values. Everything a form
 * submits arrives as `FormData`, whose values are always strings (or `File`s)
 * and may be missing entirely — nothing downstream may assume otherwise.
 *
 * This module holds the reusable *field* schemas and the `FormData` coercion
 * helpers only. Per-action schemas are added next to them as each action is
 * built (contracts/server-actions.md), and Constitution V (YAGNI) rules out a
 * generic form-builder abstraction or a schema factory here.
 */

import { z } from "zod"

import { MAX_MINUTE_OF_DAY, parseHHMM } from "@/lib/time"

/**
 * The result every Server Action returns (contracts/server-actions.md).
 *
 * Validation and rule failures are *returned*, never thrown, so the dialog can
 * render them straight from `useActionState`. `warnings` carries Soft-rule
 * messages on an otherwise successful save (FR-017).
 */
export type ActionState =
  | { ok: true; warnings?: string[] }
  | { ok: false; formErrors: string[]; fieldErrors: Record<string, string[]> }

/** A time of day as minutes from midnight — the app's only time encoding. */
export const minuteOfDay = z.int().min(0).max(MAX_MINUTE_OF_DAY)

/** An activity or transition name: trimmed, and not blank once trimmed. */
export const activityName = z.string().trim().min(1, "Name is required.")

/** A daily target or minimum block length: whole minutes, strictly positive. */
export const positiveDurationMin = z.int().positive()

/** The overlap budget: whole minutes, zero allowed (a host may lend none). */
export const nonNegativeMin = z.int().nonnegative()

/**
 * A `FormData` value read as a duration in whole minutes (daily target,
 * minimum block). Unlike a minute-of-day, this never accepts `"HH:MM"` — a
 * duration is not a clock time.
 */
export const positiveDurationMinFromForm = z
  .string()
  .transform((raw, ctx) => {
    const value = raw.trim()

    if (!/^\d+$/.test(value)) {
      ctx.addIssue("Enter a whole number of minutes.")
      return z.NEVER
    }

    return Number(value)
  })
  .pipe(positiveDurationMin)

/**
 * A `FormData` value read as a minute of day.
 *
 * `<input type="time">` submits `"HH:MM"` while a numeric or hidden field
 * submits `"600"`, and both reach the action as strings — this accepts either
 * and hands the result to `minuteOfDay` for the range check. Malformed input
 * becomes a Zod issue rather than a thrown error, because the action has to
 * report it as a field error, not crash.
 */
export const minuteOfDayFromForm = z
  .string()
  .transform((raw, ctx) => {
    const value = raw.trim()

    if (value.includes(":")) {
      const parsed = parseHHMM(value)
      if (parsed === null) {
        ctx.addIssue("Enter a valid time as HH:MM.")
        return z.NEVER
      }
      return parsed
    }

    if (!/^\d+$/.test(value)) {
      ctx.addIssue("Enter a time as HH:MM or minutes from midnight.")
      return z.NEVER
    }

    return Number(value)
  })
  .pipe(minuteOfDay)

/**
 * Read an optional `FormData` field.
 *
 * An omitted field and one the user left blank mean the same thing, so both
 * collapse to `undefined`. That lets optional groups — transitions, the
 * overlap rule — drop out of the parsed object instead of arriving as `""`
 * and failing a schema that was never meant to run on them.
 */
export function optionalFormValue(
  formData: FormData,
  name: string
): string | undefined {
  const value = formData.get(name)
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * A transition group (`pre`/`post`) is all-or-nothing: the user either fills
 * in all three fields or leaves all three blank (FR-009, contracts/
 * server-actions.md §1). Reports a field error on whichever member of the
 * group is missing so the dialog can point at the empty field, not just
 * reject the form as a whole.
 */
function checkTransitionGroupComplete(
  values: { name?: string; startMin?: number; endMin?: number },
  position: "pre" | "post",
  ctx: z.RefinementCtx
): void {
  const anyProvided =
    values.name !== undefined ||
    values.startMin !== undefined ||
    values.endMin !== undefined
  if (!anyProvided) return

  if (values.name === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `${position === "pre" ? "Pre" : "Post"}-transition name is required.`,
      path: [`${position}Name`],
    })
  }
  if (values.startMin === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `${position === "pre" ? "Pre" : "Post"}-transition start is required.`,
      path: [`${position}StartMin`],
    })
  }
  if (values.endMin === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `${position === "pre" ? "Pre" : "Post"}-transition end is required.`,
      path: [`${position}EndMin`],
    })
  }
}

/**
 * Transitions are optional (FR-009, FR-010) on either constraint type: at
 * most one `pre` and one `post` is naturally satisfied by each position
 * having a single field triple rather than a list, and each triple is
 * all-or-nothing (`checkTransitionGroupComplete`).
 */
const transitionFields = {
  preName: activityName.optional(),
  preStartMin: minuteOfDayFromForm.optional(),
  preEndMin: minuteOfDayFromForm.optional(),
  postName: activityName.optional(),
  postStartMin: minuteOfDayFromForm.optional(),
  postEndMin: minuteOfDayFromForm.optional(),
}

/**
 * Create-activity input, strict variant (contracts/server-actions.md §1).
 * `placementStartMin`/`placementEndMin` *are* the activity's fixed times, and
 * `placementKind` is always `"strict"` — a Strict activity's window cannot be
 * merely preferred.
 */
const strictActivitySchema = z.object({
  name: activityName,
  constraintType: z.literal("strict"),
  placementKind: z.literal("strict"),
  placementStartMin: minuteOfDayFromForm,
  placementEndMin: minuteOfDayFromForm,
  ...transitionFields,
})

/**
 * Create-activity input, flexible variant (FR-012, FR-013,
 * contracts/server-actions.md §1). `placementKind` picks the Temporal
 * Placement category — Preferred (Soft) or Strict (Hard) — and there is only
 * ever one `placementStartMin`/`placementEndMin` pair, so submitting both a
 * preferred and a strict window is unrepresentable at the boundary.
 */
const flexibleActivitySchema = z.object({
  name: activityName,
  constraintType: z.literal("flexible"),
  placementKind: z.enum(["preferred", "strict"]),
  placementStartMin: minuteOfDayFromForm,
  placementEndMin: minuteOfDayFromForm,
  dailyTargetMin: positiveDurationMinFromForm,
  minBlockMin: positiveDurationMinFromForm,
  ...transitionFields,
})

/**
 * Create-activity input, discriminated on `constraintType` (FR-004). Each
 * variant's fields stay exclusive to it — flexible-only fields cannot be set
 * on a strict submission and vice versa.
 */
export const createActivitySchema = z
  .discriminatedUnion("constraintType", [
    strictActivitySchema,
    flexibleActivitySchema,
  ])
  .superRefine((data, ctx) => {
    checkTransitionGroupComplete(
      { name: data.preName, startMin: data.preStartMin, endMin: data.preEndMin },
      "pre",
      ctx
    )
    checkTransitionGroupComplete(
      { name: data.postName, startMin: data.postStartMin, endMin: data.postEndMin },
      "post",
      ctx
    )
  })

/**
 * Schedule a standalone Flexible block (FR-015, contracts/server-actions.md
 * §2). `startMin` is user-supplied; `endMin` is computed in the action from
 * the activity's `minBlockMin`, never submitted.
 */
export const scheduleFlexibleBlockSchema = z.object({
  activityId: z.string().trim().min(1, "Select an activity."),
  startMin: minuteOfDayFromForm,
})

/**
 * Turn a failed `safeParse` into the error half of `ActionState`.
 *
 * `z.flattenError` types each field entry as possibly `undefined` because the
 * keys come from the parsed shape; the contract promises a plain
 * `Record<string, string[]>`, so absent and empty entries are dropped here
 * instead of at every call site.
 */
export function invalidActionState<T>(
  result: z.ZodSafeParseError<T>
): ActionState {
  const flattened = z.flattenError(result.error)

  // `fieldErrors` is a mapped type over the parsed shape; widen it once so it
  // can be walked as an ordinary record.
  const rawFieldErrors = flattened.fieldErrors as unknown as Record<
    string,
    string[] | undefined
  >

  const fieldErrors: Record<string, string[]> = {}
  for (const [field, messages] of Object.entries(rawFieldErrors)) {
    if (messages && messages.length > 0) {
      fieldErrors[field] = messages
    }
  }

  return { ok: false, formErrors: flattened.formErrors, fieldErrors }
}
