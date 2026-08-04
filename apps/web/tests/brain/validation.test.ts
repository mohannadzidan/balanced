import { describe, expect, it } from "vitest"

import { DEFAULT_COST_CONSTANTS } from "@/app/brain/engine/constants"
import {
  validateActivity,
  validateCatalog,
  validateSeparation,
} from "@/app/brain/engine/validation"
import { resolveFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

const C = DEFAULT_COST_CONSTANTS
const frame = resolveFrame("2026-07-27", 1, "UTC")

function codesOf(issues: ReturnType<typeof validateActivity>): string[] {
  return issues.map((i) => i.code)
}

describe("validateActivity", () => {
  it("passes a well-formed activity with no issues", () => {
    const gym = activity("Gym")
      .rank(1)
      .minutes(60)
      .flexible("18:00", "20:00", { drift: 30 })
      .shrink({ floor: 45 })
      .build()
    expect(validateActivity(gym, C)).toEqual([])
  })

  it.each([
    [
      "fixed + strictWindow",
      (a: ReturnType<typeof activity>) =>
        a.fixed("09:00", "10:00").strict("09:00", "10:00"),
    ],
    [
      "fixed + flexibleWindow",
      (a: ReturnType<typeof activity>) =>
        a.fixed("09:00", "10:00").flexible("09:00", "10:00"),
    ],
    // strictWindow + flexibleWindow is no longer forbidden: SPEC-v2.md
    // Section 4.6 merges them into one WindowRule type, and an activity may
    // carry more than one — the sole exception to "at most one rule of each
    // type" (Section 4.1).
    [
      "fixed + shrink",
      (a: ReturnType<typeof activity>) =>
        a.fixed("09:00", "10:00").shrink({ floor: 30 }),
    ],
    // "duplicate mandatory" no longer applies: SPEC-v2.md Section 5 turns
    // MandatoryRule into Activity.requiredCount, a plain field rather than a
    // repeatable rule, so calling .mandatory() more than once is simply
    // idempotent instead of producing two rules to flag.
  ])("flags RULE_INCOMPATIBLE for %s", (_label, configure) => {
    const built = configure(activity("Bad").rank(1).minutes(60)).build()
    expect(codesOf(validateActivity(built, C))).toContain("RULE_INCOMPATIBLE")
  })

  it("does not flag RULE_INCOMPATIBLE for two WindowRules on one activity (SPEC-v2.md Section 4.1)", () => {
    const ok = activity("Ok")
      .rank(1)
      .minutes(30)
      .strict("09:00", "10:00")
      .flexible("18:00", "20:00", { drift: 15 })
      .build()
    expect(codesOf(validateActivity(ok, C))).not.toContain("RULE_INCOMPATIBLE")
  })

  it("flags DURATION_NOT_ON_GRID for an off-grid duration", () => {
    const bad = activity("Bad").rank(1).minutes(37).build()
    expect(codesOf(validateActivity(bad, C))).toContain("DURATION_NOT_ON_GRID")
  })

  it("flags DURATION_NOT_ON_GRID for an off-grid window boundary", () => {
    const bad = activity("Bad")
      .rank(1)
      .minutes(60)
      .strict("09:03", "10:00")
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("DURATION_NOT_ON_GRID")
  })

  it("flags DURATION_NOT_ON_GRID for an off-grid shrink floor", () => {
    const bad = activity("Bad")
      .rank(1)
      .minutes(60)
      .shrink({ floor: 47 })
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("DURATION_NOT_ON_GRID")
  })

  it("flags DURATION_NOT_ON_GRID for an off-grid minimum chunk", () => {
    const bad = activity("Bad")
      .rank(1)
      .minutes(60)
      .shrink({ floor: 30, chunking: true, minChunk: 22 })
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("DURATION_NOT_ON_GRID")
  })

  it("flags ELASTICITY_INVALID when the floor exceeds the duration", () => {
    const bad = activity("Bad")
      .rank(1)
      .minutes(60)
      .shrink({ floor: 90 })
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("ELASTICITY_INVALID")
  })

  it("flags ELASTICITY_INVALID when the min chunk exceeds the floor", () => {
    const bad = activity("Bad")
      .rank(1)
      .minutes(60)
      .shrink({ floor: 30, chunking: true, minChunk: 45 })
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("ELASTICITY_INVALID")
  })

  it("no longer flags NOT_YET_SUPPORTED for minSeparationMinutes > 0 (lifted in SPEC-v2.1 §13.1 step 4)", () => {
    const bad = activity("Bad").rank(1).minutes(60).build()
    const withRepeat = {
      ...bad,
      rules: [
        {
          type: "repeat" as const,
          source: "template" as const,
          period: "day" as const,
          count: 2,
          sharedBudget: true,
          minSeparationMinutes: 15,
        },
      ],
    }
    expect(codesOf(validateActivity(withRepeat, C))).not.toContain(
      "NOT_YET_SUPPORTED"
    )
  })

  it("flags SEPARATION_UNSATISFIABLE when minSeparationMinutes makes even the day bucket infeasible", () => {
    // 2 × 600m + 1 × 600m = 1800m separation need, but a day is 1440m — the
    // activity simply cannot fit two 10h sessions separated by 10h on a
    // single day.
    const bad = activity("Bad").rank(1).minutes(600).build()
    const withRepeat = {
      ...bad,
      rules: [
        {
          type: "repeat" as const,
          source: "template" as const,
          period: "day" as const,
          count: 2,
          sharedBudget: false,
          minSeparationMinutes: 600,
        },
      ],
    }
    expect(codesOf(validateActivity(withRepeat, C))).not.toContain(
      "NOT_YET_SUPPORTED"
    )
    expect(codesOf(validateSeparation(withRepeat, frame))).toContain(
      "SEPARATION_UNSATISFIABLE"
    )
  })

  it("does not flag SEPARATION_UNSATISFIABLE when the day bucket fits", () => {
    // 3 × 60m + 2 × 360m = 900m need, day is 1440m — comfortable fit.
    const ok = activity("Ok").rank(1).minutes(60).build()
    const withRepeat = {
      ...ok,
      rules: [
        {
          type: "repeat" as const,
          source: "template" as const,
          period: "day" as const,
          count: 3,
          sharedBudget: false,
          minSeparationMinutes: 360,
        },
      ],
    }
    expect(codesOf(validateSeparation(withRepeat, frame))).not.toContain(
      "SEPARATION_UNSATISFIABLE"
    )
  })

  it.each([
    ["sharedBudget: false", { sharedBudget: false as const }],
    ["period other than day", { period: "week" as const }],
  ])(
    "does not flag NOT_YET_SUPPORTED for a RepeatRule with %s (lifted in SPEC-v2.1 §13.1 step 3)",
    (_label, override) => {
      const bad = activity("Bad").rank(1).minutes(60).build()
      const withRepeat = {
        ...bad,
        rules: [
          {
            type: "repeat" as const,
            source: "template" as const,
            period: "day" as const,
            count: 2,
            sharedBudget: true,
            minSeparationMinutes: 0,
            ...override,
          },
        ],
      }
      expect(codesOf(validateActivity(withRepeat, C))).not.toContain(
        "NOT_YET_SUPPORTED"
      )
    }
  )

  it("flags REPEAT_DUPLICATE for two RepeatRules with the same sharedBudget value", () => {
    const bad = activity("Bad").rank(1).minutes(60).build()
    const withDuplicateRepeats = {
      ...bad,
      rules: [
        {
          type: "repeat" as const,
          source: "template" as const,
          period: "day" as const,
          count: 2,
          sharedBudget: true,
          minSeparationMinutes: 0,
        },
        {
          type: "repeat" as const,
          source: "template" as const,
          period: "day" as const,
          count: 3,
          sharedBudget: true,
          minSeparationMinutes: 0,
        },
      ],
    }
    expect(codesOf(validateActivity(withDuplicateRepeats, C))).toContain(
      "REPEAT_DUPLICATE"
    )
  })

  it("does not flag REPEAT_DUPLICATE for a single RepeatRule via .repeat()", () => {
    const ok = activity("Ok").rank(1).minutes(60).repeat({ count: 2 }).build()
    expect(codesOf(validateActivity(ok, C))).not.toContain("REPEAT_DUPLICATE")
  })

  it("flags FIXED_WITH_MULTI_COUNT when a FixedRule activity has a recurrence RepeatRule count > 1 (SPEC-v2.1 §7.1)", () => {
    const bad = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .repeat({ count: 2, period: "day", sharedBudget: false })
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain(
      "FIXED_WITH_MULTI_COUNT"
    )
  })

  it("does not flag FIXED_WITH_MULTI_COUNT for a FixedRule activity with a recurrence RepeatRule count of 1", () => {
    const ok = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .repeat({ count: 1, period: "week", sharedBudget: false })
      .build()
    expect(codesOf(validateActivity(ok, C))).not.toContain(
      "FIXED_WITH_MULTI_COUNT"
    )
  })

  it("flags RULE_INCOMPATIBLE for a FixedRule combined with a chunking RepeatRule (sharedBudget: true)", () => {
    const bad = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .repeat({ count: 2 }) // defaults to sharedBudget: true
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("RULE_INCOMPATIBLE")
  })

  it("does not flag RULE_INCOMPATIBLE for a FixedRule combined with a recurrence RepeatRule (sharedBudget: false, SPEC-v2.1 §7.1)", () => {
    const ok = activity("Standup")
      .rank(1)
      .minutes(15)
      .fixed("09:00", "09:15")
      .repeat({ count: 1, period: "week", sharedBudget: false })
      .build()
    expect(codesOf(validateActivity(ok, C))).not.toContain("RULE_INCOMPATIBLE")
  })

  it("flags WINDOW_INVERTED when a strict window ends before it starts", () => {
    const bad = activity("Bad")
      .rank(1)
      .minutes(30)
      .strict("10:00", "09:00")
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("WINDOW_INVERTED")
  })

  it("flags WINDOW_TOO_SHORT when a strict window can't fit the duration and there's no shrink", () => {
    const bad = activity("Bad")
      .rank(1)
      .minutes(90)
      .strict("09:00", "10:00")
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("WINDOW_TOO_SHORT")
  })

  it("does not flag WINDOW_TOO_SHORT when a ShrinkRule is present", () => {
    const ok = activity("Ok")
      .rank(1)
      .minutes(90)
      .strict("09:00", "10:00")
      .shrink({ floor: 30 })
      .build()
    expect(codesOf(validateActivity(ok, C))).not.toContain("WINDOW_TOO_SHORT")
  })

  it("flags DRIFT_UNAVOIDABLE when the window is too short for the allowed drift", () => {
    const bad = activity("Bad")
      .rank(1)
      .minutes(90)
      .flexible("18:00", "19:00", { drift: 10 })
      .build()
    expect(codesOf(validateActivity(bad, C))).toContain("DRIFT_UNAVOIDABLE")
  })

  it("flags NO_ELIGIBLE_DAYS when the activity can never be generated", () => {
    const bad = activity("Bad").rank(1).minutes(30).days().build()
    expect(codesOf(validateActivity(bad, C))).toContain("NO_ELIGIBLE_DAYS")
  })

  it.each([-1, 2])(
    "flags REQUIRED_COUNT_INVALID for requiredCount %i (SPEC-v2.md Section 8.2)",
    (n) => {
      const bad = activity("Bad").rank(1).minutes(30).required(n).build()
      expect(codesOf(validateActivity(bad, C))).toContain(
        "REQUIRED_COUNT_INVALID"
      )
    }
  )

  it.each([0, 1])(
    "does not flag REQUIRED_COUNT_INVALID for requiredCount %i",
    (n) => {
      const ok = activity("Ok").rank(1).minutes(30).required(n).build()
      expect(codesOf(validateActivity(ok, C))).not.toContain(
        "REQUIRED_COUNT_INVALID"
      )
    }
  )

  it("flags DOMINANCE_VIOLATION for a deliberately broken activity", () => {
    const broken = activity("Broken")
      .rank(1)
      .minutes(1000)
      .shrink({ floor: 0 })
      .build()
    expect(codesOf(validateActivity(broken, C))).toContain(
      "DOMINANCE_VIOLATION"
    )
  })
})

describe("validateCatalog", () => {
  it("passes a catalogue with unique ranks", () => {
    const catalog = [
      activity("A").rank(1).minutes(30).build(),
      activity("B").rank(2).minutes(30).build(),
    ]
    expect(validateCatalog(catalog)).toEqual([])
  })

  it("flags PRIORITY_DUPLICATE when two activities share a rank", () => {
    const catalog = [
      activity("A").rank(1).minutes(30).build(),
      activity("B").rank(1).minutes(30).build(),
    ]
    expect(codesOf(validateCatalog(catalog))).toContain("PRIORITY_DUPLICATE")
  })

  it("flags SEQUENCE_MULTIPLE when two activities are both a pre of the same host", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).build(),
      activity("A").rank(2).minutes(15).sequence("pre", "work").build(),
      activity("B").rank(3).minutes(15).sequence("pre", "work").build(),
    ]
    expect(codesOf(validateCatalog(catalog))).toContain("SEQUENCE_MULTIPLE")
  })

  it("does not flag SEQUENCE_MULTIPLE for a distinct pre and post of the same host", () => {
    const catalog = [
      activity("Work").rank(1).minutes(60).build(),
      activity("A").rank(2).minutes(15).sequence("pre", "work").build(),
      activity("B").rank(3).minutes(15).sequence("post", "work").build(),
    ]
    expect(codesOf(validateCatalog(catalog))).not.toContain("SEQUENCE_MULTIPLE")
  })

  it("flags SEQUENCE_CYCLE for a direct cycle (A pre B, B pre A)", () => {
    const catalog = [
      activity("A").rank(1).minutes(15).sequence("pre", "b").build(),
      activity("B").rank(2).minutes(15).sequence("pre", "a").build(),
    ]
    expect(codesOf(validateCatalog(catalog))).toContain("SEQUENCE_CYCLE")
  })

  it("flags SEQUENCE_CYCLE for a longer cycle (A pre B, B pre C, C pre A)", () => {
    const catalog = [
      activity("A").rank(1).minutes(15).sequence("pre", "b").build(),
      activity("B").rank(2).minutes(15).sequence("pre", "c").build(),
      activity("C").rank(3).minutes(15).sequence("pre", "a").build(),
    ]
    const issues = validateCatalog(catalog)
    expect(codesOf(issues)).toContain("SEQUENCE_CYCLE")
    expect(issues.filter((i) => i.code === "SEQUENCE_CYCLE")).toHaveLength(3)
  })

  it("does not flag SEQUENCE_CYCLE for a plain chain (A pre B, B pre C)", () => {
    const catalog = [
      activity("C").rank(1).minutes(60).build(),
      activity("B").rank(2).minutes(15).sequence("pre", "c").build(),
      activity("A").rank(3).minutes(15).sequence("pre", "b").build(),
    ]
    expect(codesOf(validateCatalog(catalog))).not.toContain("SEQUENCE_CYCLE")
  })

  it("flags GUEST_OUTRANKS_HOST when a guest is ranked ahead of its host", () => {
    const catalog = [
      activity("Email").id("email").rank(1).minutes(30).build(),
      activity("Work")
        .rank(2)
        .minutes(480)
        .overlap({ budget: 60, guests: ["email"] })
        .build(),
    ]
    expect(codesOf(validateCatalog(catalog))).toContain("GUEST_OUTRANKS_HOST")
  })

  it("does not flag GUEST_OUTRANKS_HOST when the host outranks its guest", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .overlap({ budget: 60, guests: ["email"] })
        .build(),
      activity("Email").id("email").rank(2).minutes(30).build(),
    ]
    expect(codesOf(validateCatalog(catalog))).not.toContain(
      "GUEST_OUTRANKS_HOST"
    )
  })
})
