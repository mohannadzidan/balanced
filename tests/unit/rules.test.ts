import { describe, it, expect } from "vitest"

import {
  checkEndAfterStart,
  checkStrictActivityPlacement,
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
