import { describe, expect, it } from "vitest"

import { applyBackdating } from "@/app/brain/engine/lifecycle"
import type { TimelineActivity } from "@/app/brain/engine/types"

function instance(overrides: Partial<TimelineActivity>): TimelineActivity {
  return {
    id: "id",
    activityId: "id",
    date: "2024-06-15",
    name: "Activity",
    durationMinutes: 60,
    priorityRank: 1,
    rules: [],
    state: "PLANNED",
    completedSource: null,
    plannedStart: 0,
    plannedEnd: 60,
    actualStart: null,
    actualEnd: null,
    scheduledMinutes: 60,
    chunkIndex: 1,
    chunkCount: 1,
    chunkGroupId: null,
    hostInstanceId: null,
    isAdhoc: false,
    spanningFromPreviousDay: false,
    relaxations: [],
    locked: false,
    skipReason: null,
    ...overrides,
  }
}

describe("applyBackdating", () => {
  it("leaves a PLANNED instance untouched when now is before it starts", () => {
    const inst = instance({ plannedStart: 60, plannedEnd: 120 })
    const result = applyBackdating([inst], 30)
    expect(result.changed).toBe(false)
    expect(result.instances[0]).toEqual(inst)
  })

  it("marks a PLANNED instance ACTIVE once now falls inside its span", () => {
    const inst = instance({ plannedStart: 60, plannedEnd: 120 })
    const result = applyBackdating([inst], 90)
    expect(result.changed).toBe(true)
    expect(result.instances[0].state).toBe("ACTIVE")
    expect(result.instances[0].actualStart).toBe(60)
    expect(result.instances[0].actualEnd).toBeNull()
  })

  it("marks a PLANNED instance COMPLETED (backdated) once now is past its end", () => {
    const inst = instance({ plannedStart: 60, plannedEnd: 120 })
    const result = applyBackdating([inst], 150)
    expect(result.changed).toBe(true)
    expect(result.instances[0].state).toBe("COMPLETED")
    expect(result.instances[0].completedSource).toBe("backdated")
    expect(result.instances[0].actualStart).toBe(60)
    expect(result.instances[0].actualEnd).toBe(120)
  })

  it("auto-completes an ACTIVE instance once now passes its planned end", () => {
    const inst = instance({
      plannedStart: 60,
      plannedEnd: 120,
      state: "ACTIVE",
      actualStart: 60,
    })
    const result = applyBackdating([inst], 150)
    expect(result.changed).toBe(true)
    expect(result.instances[0].state).toBe("COMPLETED")
    expect(result.instances[0].completedSource).toBe("backdated")
    expect(result.instances[0].actualStart).toBe(60)
    expect(result.instances[0].actualEnd).toBe(120)
  })

  it("leaves COMPLETED, SKIPPED, and CARRIED_IN instances untouched regardless of now", () => {
    const completed = instance({
      id: "c",
      state: "COMPLETED",
      completedSource: "user",
    })
    const skipped = instance({
      id: "s",
      state: "SKIPPED",
      plannedStart: null,
      plannedEnd: null,
      skipReason: "USER_SKIPPED",
    })
    const carriedIn = instance({ id: "ci", state: "CARRIED_IN" })
    const result = applyBackdating([completed, skipped, carriedIn], 10_000)
    expect(result.changed).toBe(false)
    expect(result.instances).toEqual([completed, skipped, carriedIn])
  })

  it("leaves a SKIPPED instance with null planned times untouched even though it's PLANNED-adjacent logic doesn't apply", () => {
    const skipped = instance({
      state: "SKIPPED",
      plannedStart: null,
      plannedEnd: null,
      skipReason: "NO_FREE_SPACE",
    })
    const result = applyBackdating([skipped], 500)
    expect(result.changed).toBe(false)
  })

  it("is idempotent: calling twice with the same now produces no further change", () => {
    const inst = instance({ plannedStart: 60, plannedEnd: 120 })
    const first = applyBackdating([inst], 150)
    const second = applyBackdating(first.instances, 150)
    expect(second.changed).toBe(false)
    expect(second.instances).toEqual(first.instances)
  })

  it("only changes the affected instance, leaving others in the list untouched", () => {
    const untouched = instance({
      id: "future",
      plannedStart: 600,
      plannedEnd: 660,
    })
    const past = instance({ id: "past", plannedStart: 0, plannedEnd: 60 })
    const result = applyBackdating([untouched, past], 100)
    expect(result.instances[0]).toEqual(untouched)
    expect(result.instances[1].state).toBe("COMPLETED")
  })
})
