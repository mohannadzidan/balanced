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
import type { StrictActivity } from "@/lib/domain/types"
import { checkStrictActivityPlacement } from "@/lib/domain/rules"
import {
  createActivitySchema,
  invalidActionState,
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

  const activity: StrictActivity = {
    id: randomUUID(),
    name: parsed.data.name,
    constraintType: "strict",
    placement,
    overlap: null,
    createdDate: todayISO(),
  }

  await insertActivityWithRules({ activity, transitions: [] })
  revalidatePath("/")

  return { ok: true }
}
