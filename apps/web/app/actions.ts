"use server"

/**
 * Server Actions: the only mutation entry points (contracts/server-actions.md).
 * Each parses `FormData` with Zod, evaluates the pure rule functions, persists
 * through `lib/db/queries.ts`, then revalidates the timeline route so it
 * updates without a manual refresh (FR-007).
 */

import { randomUUID } from "node:crypto"

import { revalidatePath } from "next/cache"

import {
  getOccupiedRanges,
  getDayView,
  insertActivityWithRules,
  insertScheduledBlock,
} from "@/lib/db/queries"
import type {
  Activity,
  StrictWindow,
  TemporalPlacementRule,
  Transition,
} from "@/lib/domain/types"
import {
  checkEndAfterStart,
  checkNoOverlap,
  checkStrictActivityPlacement,
  checkTransitions,
  evaluatePlacement,
} from "@/lib/domain/rules"
import {
  createActivitySchema,
  invalidActionState,
  optionalFormValue,
  scheduleFlexibleBlockSchema,
  type ActionState,
} from "@/lib/domain/validation"
import { todayISO } from "@/lib/time"

/**
 * Creates a Strict or Flexible activity with its required Temporal Placement
 * rule, optional transitions, and — for Strict activities — the Overlap Rule
 * (contracts/server-actions.md §1, arriving with a later user story).
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
    dailyTargetMin: formData.get("dailyTargetMin"),
    minBlockMin: formData.get("minBlockMin"),
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

  const activityId = randomUUID()

  let activity: Activity
  if (parsed.data.constraintType === "strict") {
    const placement: StrictWindow = {
      kind: "strict",
      startMin: parsed.data.placementStartMin,
      endMin: parsed.data.placementEndMin,
    }
    const verdict = checkStrictActivityPlacement(placement)
    if (!verdict.ok) {
      return { ok: false, formErrors: [verdict.message], fieldErrors: {} }
    }
    activity = {
      id: activityId,
      name: parsed.data.name,
      constraintType: "strict",
      placement,
      overlap: null,
      createdDate: todayISO(),
    }
  } else {
    const placement: TemporalPlacementRule = {
      kind: parsed.data.placementKind,
      startMin: parsed.data.placementStartMin,
      endMin: parsed.data.placementEndMin,
    }
    const verdict = checkEndAfterStart(placement.startMin, placement.endMin)
    if (!verdict.ok) {
      return { ok: false, formErrors: [verdict.message], fieldErrors: {} }
    }
    activity = {
      id: activityId,
      name: parsed.data.name,
      constraintType: "flexible",
      dailyTargetMin: parsed.data.dailyTargetMin,
      minBlockMin: parsed.data.minBlockMin,
      placement,
      createdDate: todayISO(),
    }
  }

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
    return {
      ok: false,
      formErrors: [transitionsVerdict.message],
      fieldErrors: {},
    }
  }

  await insertActivityWithRules({ activity, transitions })
  revalidatePath("/")

  return { ok: true }
}

/**
 * Places a standalone Flexible block, `host_activity_id = NULL`
 * (contracts/server-actions.md §2). A Strict-Window violation is Hard and
 * rejects the write; a Preferred-Window violation is Soft and persists with
 * a warning (FR-016, FR-017). The overlap check against the rest of the
 * day's timeline is always Hard (FR-016).
 */
export async function scheduleFlexibleBlock(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = scheduleFlexibleBlockSchema.safeParse({
    activityId: formData.get("activityId"),
    startMin: formData.get("startMin"),
  })

  if (!parsed.success) {
    return invalidActionState(parsed)
  }

  const date = todayISO()
  const dayView = await getDayView(date)
  const activity = dayView.activities.find(
    (candidate) => candidate.id === parsed.data.activityId
  )

  if (!activity || activity.constraintType !== "flexible") {
    return {
      ok: false,
      formErrors: ["Select a Flexible activity."],
      fieldErrors: {},
    }
  }

  const startMin = parsed.data.startMin
  const endMin = startMin + activity.minBlockMin

  const placementVerdict = evaluatePlacement(
    activity.placement,
    startMin,
    endMin
  )
  if (!placementVerdict.ok && placementVerdict.classification === "hard") {
    return {
      ok: false,
      formErrors: [placementVerdict.message],
      fieldErrors: {},
    }
  }

  const occupiedRanges = await getOccupiedRanges(date)
  const overlapVerdict = checkNoOverlap({ startMin, endMin }, occupiedRanges)
  if (!overlapVerdict.ok) {
    return { ok: false, formErrors: [overlapVerdict.message], fieldErrors: {} }
  }

  await insertScheduledBlock({
    id: randomUUID(),
    activityId: activity.id,
    date,
    startMin,
    endMin,
    hostActivityId: null,
  })
  revalidatePath("/")

  return placementVerdict.ok
    ? { ok: true }
    : { ok: true, warnings: [placementVerdict.message] }
}
