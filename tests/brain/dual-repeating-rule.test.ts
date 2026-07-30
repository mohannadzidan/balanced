// SPEC-v2.1 §5.4: "an activity may legally carry [a recurrence RepeatRule
// and a chunking RepeatRule] simultaneously" — e.g. "Gym three times a week,
// each session splittable into two." This is the exact combination newly
// unblocked by lifting the NOT_YET_SUPPORTED gate (SPEC-v2.1 §13.1 step 3),
// and it's exactly the combination the old `repeatRuleOf`/
// `violatesDominance` `.find(r => r.type === "repeat")` lookups mishandled:
// when the recurrence rule (sharedBudget: false) is declared *before* the
// chunking rule (sharedBudget: true), the naive find returned the recurrence
// rule first, so `placeWithElasticity`'s
// `repeat?.sharedBudget ? planChunks(...) : null` silently disabled chunking
// even though a real chunking rule existed on the same activity.
//
// This regression test builds the activities in the rule-declaration order
// that breaks the naive code and asserts chunking still runs. It uses
// layouts that are deterministic regardless of the interim cross-day
// placement policy SPEC-v2.1 §6.1 explicitly accepts (a recurrence's day
// assignment is soft until `minSeparationMinutes` lands in Step 4).

import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "@/tests/brain/support/solve-checked"
import { resolveFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"
import { repeatRuleOf } from "@/app/brain/engine/greedy"
import type { Activity, RepeatRule, Rule } from "@/app/brain/engine/types"

const recurrenceRule: RepeatRule = {
  type: "repeat",
  source: "template",
  period: "week",
  count: 3,
  sharedBudget: false,
  minSeparationMinutes: 0,
}
const chunkingRule: RepeatRule = {
  type: "repeat",
  source: "template",
  period: "day",
  count: 2,
  sharedBudget: true,
  minSeparationMinutes: 0,
}

function buildActivity(id: string, rules: Rule[]): Activity {
  return {
    id,
    name: id,
    durationMinutes: 60,
    priorityRank: 1,
    enabled: true,
    rules,
    requiredCount: 0,
  }
}

describe("repeatRuleOf — disambiguates chunking vs recurrence (SPEC-v2.1 §5.4)", () => {
  it("returns the chunking rule (sharedBudget: true) regardless of declaration order", () => {
    const recurrenceFirst = buildActivity("gym-rf", [recurrenceRule, chunkingRule])
    const chunkingFirst = buildActivity("gym-cf", [chunkingRule, recurrenceRule])

    const r1 = repeatRuleOf(recurrenceFirst)
    const r2 = repeatRuleOf(chunkingFirst)

    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r1?.sharedBudget).toBe(true)
    expect(r2?.sharedBudget).toBe(true)
  })

  it("returns null when only a recurrence rule is present (no chunking)", () => {
    const gym = activity("Gym").rank(1).minutes(60)
      .repeat({ count: 3, period: "week", sharedBudget: false })
      .build()
    expect(repeatRuleOf(gym)).toBeNull()
  })

  it("returns the chunking rule when only a chunking rule is present (Drop 1 behavior preserved)", () => {
    const gym = activity("Gym").rank(1).minutes(60)
      .shrink({ floor: 30, chunking: true, minChunk: 30, maxChunks: 2 })
      .build()
    const r = repeatRuleOf(gym)
    expect(r).not.toBeNull()
    expect(r?.sharedBudget).toBe(true)
  })
})

describe("SPEC-v2.1 §5.4: one chunking + one recurrence RepeatRule on the same activity (end-to-end)", () => {
  it("applies chunking end-to-end even when the recurrence rule is declared before the chunking rule", () => {
    // One occurrence (period: "frame", count: 1) over a single day, with
    // chunking max=2 — so the recurrence partitions into exactly one
    // occurrence and chunking splits that occurrence's 60m into two 30m
    // blocks within its one strict window. One occurrence, one chunk group
    // of two blocks: the smallest layout that deterministically exercises
    // `placeWithElasticity`'s chunking branch through the buggy lookup
    // order without depending on interim cross-day placement policy.
    //
    // build() emits recurrence BEFORE chunking:
    //   .repeat({ count: 1, period: "frame", sharedBudget: false }) // recurrence
    //   .shrink({ floor: 30, chunking: true, minChunk: 30, maxChunks: 2 }) // chunking
    // Under the old bug, `repeat?.sharedBudget` was false (the recurrence
    // rule won first-match) so chunkPlan was null and Gym would be shrunk to
    // 30m or skipped — never chunked.
    const frame = resolveFrame("2026-07-27", 1, "UTC")

    // A 60m window with its middle 30m occupied by a higher-ranking blocker,
    // leaving two 30m gaps: the full 60m single block is infeasible at zero
    // drift, and the 2x30 chunk plan is the only feasible way to schedule
    // the full 60m duration.
    const blocker = activity("Blocker")
      .rank(1)
      .minutes(30)
      .window("09:30", "10:00")
      .build()

    const gym = activity("Gym")
      .rank(2)
      .minutes(60)
      .window("09:00", "10:30")
      .repeat({ count: 1, period: "frame", sharedBudget: false }) // recurrence FIRST
      .shrink({ floor: 30, chunking: true, minChunk: 30, maxChunks: 2 }) // chunking SECOND
      .build()

    const result = solve({
      dayFrame: frame,
      now: 0,
      catalog: [blocker, gym],
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })

    if (result.status === "REJECTED") {
      throw new Error(`unexpected rejection: ${JSON.stringify(result.rejection)}`)
    }

    const placed = result.timeline.instances.filter(
      (i) => i.name === "Gym" && i.state === "PLANNED"
    )

    // Chunking firing is the fix: two 30m blocks, one chunk group.
    expect(placed).toHaveLength(2)
    expect(placed.every((b) => b.blockCount === 2)).toBe(true)
    expect(placed[0].blockIndex).toBe(1)
    expect(placed[1].blockIndex).toBe(2)

    // One budget group spanning both blocks (§5.4: chunkGroupId == occurrenceId).
    expect(placed[0].chunkGroupId).toBe(placed[1].chunkGroupId)

    // The two blocks sum to the full 60m duration and stay inside the window.
    const total = placed.reduce((s, b) => s + b.scheduledMinutes, 0)
    expect(total).toBe(60)
    const day0 = frame.days[0]
    for (const b of placed) {
      expect(b.plannedStart).toBeGreaterThanOrEqual(day0.startOffset + 9 * 60)
      expect(b.plannedEnd).toBeLessThanOrEqual(day0.startOffset + 10 * 60 + 30)
    }

    // {type:"chunk"} relaxation is recorded (at least once) — the positive
    // signal chunking ran, which the bug would have withheld.
    const chunkRelaxations = placed.flatMap((b) => b.relaxations).filter((r) => r.type === "chunk")
    expect(chunkRelaxations.length).toBeGreaterThan(0)
  })
})
