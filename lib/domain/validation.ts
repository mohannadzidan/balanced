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
