"use server"

/**
 * Server Actions: the only mutation entry points (contracts/server-actions.md).
 * Each parses `FormData` with Zod, evaluates the pure rule functions, persists
 * through `lib/db/queries.ts`, then revalidates the timeline route so it
 * updates without a manual refresh (FR-007).
 */

import { randomUUID } from "node:crypto"

import { revalidatePath } from "next/cache"

import { insertActivityWithRules } from "@/lib/db/queries"
import type { StrictActivity, Transition } from "@/lib/domain/types"
import { checkStrictActivityPlacement, checkTransitions } from "@/lib/domain/rules"
import {
  createActivitySchema,
  invalidActionState,
  optionalFormValue,
  type ActionState,
} from "@/lib/domain/validation"
import { todayISO } from "@/lib/time"

/**
 * Creates a Strict activity with its required Temporal Placement rule
 * (contracts/server-actions.md §1). Flexible activities, transitions, and the
 * Overlap Rule arrive with later user stories.
 */
export async function createActivity(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = createActivitySchema.safeParse({
    name: formData.get("name"),
    constraintType: formData.get("constraintType"),
    placementKind: formData.get("placementKind"),
    placementStartMin: formData.get("placementStartMin"),
    placementEndMin: formData.get("placementEndMin"),
    preName: optionalFormValue(formData, "preName"),
    preStartMin: optionalFormValue(formData, "preStartMin"),
    preEndMin: optionalFormValue(formData, "preEndMin"),
    postName: optionalFormValue(formData, "postName"),
    postStartMin: optionalFormValue(formData, "postStartMin"),
    postEndMin: optionalFormValue(formData, "postEndMin"),
  })

  if (!parsed.success) {
    return invalidActionState(parsed)
  }

  const placement = {
    kind: "strict" as const,
    startMin: parsed.data.placementStartMin,
    endMin: parsed.data.placementEndMin,
  }

  const verdict = checkStrictActivityPlacement(placement)
  if (!verdict.ok) {
    return { ok: false, formErrors: [verdict.message], fieldErrors: {} }
  }

  const activityId = randomUUID()
  const transitions: Transition[] = []
  if (parsed.data.preName !== undefined) {
    transitions.push({
      id: randomUUID(),
      activityId,
      position: "pre",
      name: parsed.data.preName,
      startMin: parsed.data.preStartMin!,
      endMin: parsed.data.preEndMin!,
    })
  }
  if (parsed.data.postName !== undefined) {
    transitions.push({
      id: randomUUID(),
      activityId,
      position: "post",
      name: parsed.data.postName,
      startMin: parsed.data.postStartMin!,
      endMin: parsed.data.postEndMin!,
    })
  }

  const transitionsVerdict = checkTransitions(transitions)
  if (!transitionsVerdict.ok) {
    return { ok: false, formErrors: [transitionsVerdict.message], fieldErrors: {} }
  }

  const activity: StrictActivity = {
    id: activityId,
    name: parsed.data.name,
    constraintType: "strict",
    placement,
    overlap: null,
    createdDate: todayISO(),
  }

  await insertActivityWithRules({ activity, transitions })
  revalidatePath("/")

  return { ok: true }
}
