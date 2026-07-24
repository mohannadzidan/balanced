import { describe, it, expect } from "vitest"

import {
  checkEndAfterStart,
  checkNoOverlap,
  checkStrictActivityPlacement,
  checkTransitions,
  evaluatePlacement,
  hard,
  ok,
  soft,
  type RuleVerdict,
} from "../../lib/domain/rules"

describe("ok", () => {
  it("produces a passing verdict", () => {
    expect(ok()).toEqual({ ok: true })
  })
})

describe("hard", () => {
  it("produces a failing verdict classified as hard", () => {
    expect(hard("nope")).toEqual({
      ok: false,
      classification: "hard",
      message: "nope",
    })
  })

  it("sets the classification to exactly hard", () => {
    const verdict = hard("nope")
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })
})

describe("soft", () => {
  it("produces a failing verdict classified as soft", () => {
    expect(soft("careful")).toEqual({
      ok: false,
      classification: "soft",
      message: "careful",
    })
  })

  it("sets the classification to exactly soft", () => {
    const verdict = soft("careful")
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("soft")
  })
})

describe("checkEndAfterStart", () => {
  it("rejects equal start and end times as hard", () => {
    const verdict = checkEndAfterStart(600, 600)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })

  it("rejects reversed times as hard", () => {
    const verdict = checkEndAfterStart(700, 600)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })

  it("accepts a range with positive length", () => {
    expect(checkEndAfterStart(600, 630)).toEqual({ ok: true })
  })

  it("carries a non-empty message on every rejection", () => {
    const rejections: RuleVerdict[] = [
      checkEndAfterStart(600, 600),
      checkEndAfterStart(700, 600),
    ]

    for (const verdict of rejections) {
      expect(verdict.ok).toBe(false)
      if (verdict.ok) continue
      expect(verdict.message.length).toBeGreaterThan(0)
    }
  })
})

describe("checkStrictActivityPlacement", () => {
  it("rejects End <= Start as hard (FR-005, AS-4)", () => {
    const verdict = checkStrictActivityPlacement({
      kind: "strict",
      startMin: 600,
      endMin: 600,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })

  it("rejects a preferred-kind rule on a strict activity as hard", () => {
    const verdict = checkStrictActivityPlacement({
      kind: "preferred",
      startMin: 600,
      endMin: 630,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })

  it("accepts a valid 10:00-10:30 strict window", () => {
    expect(
      checkStrictActivityPlacement({ kind: "strict", startMin: 600, endMin: 630 })
    ).toEqual({ ok: true })
  })
})

describe("checkTransitions", () => {
  it("rejects an invalid range as hard (Edge Case)", () => {
    const verdict = checkTransitions([{ startMin: 480, endMin: 480 }])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })

  it("accepts a gap between a transition and its parent activity", () => {
    // Commute 08:00-09:30, parent activity starts at 10:00 — no adjacency
    // enforcement (data-model.md §4).
    expect(checkTransitions([{ startMin: 480, endMin: 570 }])).toEqual({
      ok: true,
    })
  })

  it("accepts a pre-only transition list", () => {
    expect(checkTransitions([{ startMin: 480, endMin: 600 }])).toEqual({
      ok: true,
    })
  })

  it("accepts an empty transition list", () => {
    expect(checkTransitions([])).toEqual({ ok: true })
  })

  it("rejects when any of multiple transitions is invalid", () => {
    const verdict = checkTransitions([
      { startMin: 480, endMin: 600 },
      { startMin: 1080, endMin: 1000 },
    ])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })
})

describe("evaluatePlacement", () => {
  it("rejects a block outside a Strict Window as hard (FR-016)", () => {
    const verdict = evaluatePlacement(
      { kind: "strict", startMin: 1080, endMin: 1380 },
      480,
      600
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })

  it("rejects a block outside a Preferred Window as soft (FR-017)", () => {
    const verdict = evaluatePlacement(
      { kind: "preferred", startMin: 1080, endMin: 1380 },
      480,
      600
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("soft")
  })

  it("accepts a block fully inside the window", () => {
    expect(
      evaluatePlacement({ kind: "preferred", startMin: 1080, endMin: 1380 }, 1140, 1260)
    ).toEqual({ ok: true })
  })

  it("accepts a block touching both window endpoints", () => {
    expect(
      evaluatePlacement({ kind: "strict", startMin: 1080, endMin: 1380 }, 1080, 1380)
    ).toEqual({ ok: true })
  })
})

describe("checkNoOverlap", () => {
  it("accepts a range with no occupied ranges", () => {
    expect(checkNoOverlap({ startMin: 600, endMin: 660 }, [])).toEqual({
      ok: true,
    })
  })

  it("accepts a range that only touches an occupied range's endpoint", () => {
    expect(
      checkNoOverlap({ startMin: 600, endMin: 660 }, [
        { startMin: 540, endMin: 600 },
      ])
    ).toEqual({ ok: true })
  })

  it("rejects a genuine intersection as hard", () => {
    const verdict = checkNoOverlap({ startMin: 600, endMin: 660 }, [
      { startMin: 630, endMin: 700 },
    ])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })

  it("checks against every occupied range, not just the first", () => {
    const verdict = checkNoOverlap({ startMin: 600, endMin: 660 }, [
      { startMin: 0, endMin: 60 },
      { startMin: 630, endMin: 700 },
    ])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.classification).toBe("hard")
  })
})
