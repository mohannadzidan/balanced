import { describe, expect, it } from "vitest"

import { solveChecked as solve } from "./support/solve-checked"
import { resolveDayFrame } from "../src/engine/time"
import type { Activity, SolveResult, Weekday } from "../src/engine/types"
import { activity } from "./support/fixtures"

/**
 * SPEC-v2.md Section 12.1 criterion 8, "the cheapest possible proof" that
 * Drop 1's rule-vocabulary merge is behaviour-preserving: for a corpus of
 * catalogues expressed two ways — once via the fluent builder's sugar
 * (`.strict()/.flexible()/.mandatory()/.shrink()`, exercising the mapping
 * table in Section 10.1) and once by hand-assembling the new-shape rules
 * directly (`WindowRule`, `requiredCount`, `ElasticityRule`+`RepeatRule`) —
 * `solve()` must produce equivalent timelines. Rules array order is an
 * implementation artifact of which order the builder happened to push
 * rules in, not scheduling behaviour, so it's excluded from the comparison;
 * everything that actually describes the solved day (placement, cost,
 * status, diagnostics) is compared in full.
 */

const ALL_WEEKDAYS: readonly Weekday[] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]

const dayFrame = resolveDayFrame("2024-06-17", "UTC") // a Monday

function stripRules(result: SolveResult) {
  return {
    ...result,
    timeline: {
      ...result.timeline,
      instances: result.timeline.instances.map((inst) => {
        const clone: Record<string, unknown> = { ...inst }
        delete clone.rules
        return clone
      }),
    },
  }
}

function expectEquivalent(sugar: Activity[], manual: Activity[]): void {
  const sugarResult = solve({
    dayFrame,
    now: 0,
    catalog: sugar,
    existing: [],
    carryIn: [],
    event: { type: "GENERATE_DAY" },
  })
  const manualResult = solve({
    dayFrame,
    now: 0,
    catalog: manual,
    existing: [],
    carryIn: [],
    event: { type: "GENERATE_DAY" },
  })
  expect(stripRules(manualResult)).toEqual(stripRules(sugarResult))
}

describe("Drop 1 differential equivalence (SPEC-v2.md Section 12.1 criterion 8)", () => {
  it("FixedRule + strict/flexible windows, including one activity with two windows", () => {
    const sugar = [
      activity("Commute").rank(1).minutes(30).fixed("08:00", "08:30").build(),
      activity("Work").rank(2).minutes(60).strict("09:00", "10:00").build(),
      activity("Dinner")
        .rank(3)
        .minutes(45)
        .flexible("18:00", "20:00", { drift: 30 })
        .strict("12:00", "13:00")
        .build(),
    ]
    const manual: Activity[] = [
      {
        id: "commute",
        name: "Commute",
        durationMinutes: 30,
        priorityRank: 1,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "fixed",
            source: "template",
            startWall: "08:00",
            endWall: "08:30",
          },
        ],
      },
      {
        id: "work",
        name: "Work",
        durationMinutes: 60,
        priorityRank: 2,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "window",
            source: "template",
            days: ALL_WEEKDAYS,
            startWall: "09:00",
            endWall: "10:00",
            maxDriftMinutes: 0,
          },
        ],
      },
      {
        id: "dinner",
        name: "Dinner",
        durationMinutes: 45,
        priorityRank: 3,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "window",
            source: "template",
            days: ALL_WEEKDAYS,
            startWall: "12:00",
            endWall: "13:00",
            maxDriftMinutes: 0,
          },
          {
            type: "window",
            source: "template",
            days: ALL_WEEKDAYS,
            startWall: "18:00",
            endWall: "20:00",
            maxDriftMinutes: 30,
          },
        ],
      },
    ]
    expectEquivalent(sugar, manual)
  })

  it("requiredCount (mandatory), including the hard-set backtracking path", () => {
    const sugar = [
      activity("Sleep").rank(1).minutes(400).mandatory().build(),
      activity("Gym")
        .rank(2)
        .minutes(90)
        .mandatory()
        .strict("06:00", "08:00")
        .build(),
      activity("Reading").rank(3).minutes(30).build(),
    ]
    const manual: Activity[] = [
      {
        id: "sleep",
        name: "Sleep",
        durationMinutes: 400,
        priorityRank: 1,
        enabled: true,
        requiredCount: 1,
        rules: [],
      },
      {
        id: "gym",
        name: "Gym",
        durationMinutes: 90,
        priorityRank: 2,
        enabled: true,
        requiredCount: 1,
        rules: [
          {
            type: "window",
            source: "template",
            days: ALL_WEEKDAYS,
            startWall: "06:00",
            endWall: "08:00",
            maxDriftMinutes: 0,
          },
        ],
      },
      {
        id: "reading",
        name: "Reading",
        durationMinutes: 30,
        priorityRank: 3,
        enabled: true,
        requiredCount: 0,
        rules: [],
      },
    ]
    expectEquivalent(sugar, manual)
  })

  it("ElasticityRule + shared-budget RepeatRule (shrink and chunking)", () => {
    const sugar = [
      activity("Work").rank(1).minutes(480).fixed("09:00", "17:00").build(),
      activity("Deep Work")
        .rank(2)
        .minutes(120)
        .flexible("17:00", "22:00", { drift: 0 })
        .shrink({ floor: 60, chunking: true, minChunk: 45, maxChunks: 3 })
        .build(),
    ]
    const manual: Activity[] = [
      {
        id: "work",
        name: "Work",
        durationMinutes: 480,
        priorityRank: 1,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "fixed",
            source: "template",
            startWall: "09:00",
            endWall: "17:00",
          },
        ],
      },
      {
        id: "deep-work",
        name: "Deep Work",
        durationMinutes: 120,
        priorityRank: 2,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "window",
            source: "template",
            days: ALL_WEEKDAYS,
            startWall: "17:00",
            endWall: "22:00",
            maxDriftMinutes: 0,
          },
          {
            type: "elasticity",
            source: "template",
            minTotalMinutes: 60,
            minBlockMinutes: 45,
          },
          {
            type: "repeat",
            source: "template",
            period: "day",
            count: 3,
            sharedBudget: true,
            minSeparationMinutes: 0,
          },
        ],
      },
    ]
    expectEquivalent(sugar, manual)
  })

  it("SequenceRule (pre/post chain)", () => {
    const sugar = [
      activity("Work").rank(1).minutes(480).strict("09:00", "17:00").build(),
      activity("Commute")
        .rank(2)
        .minutes(30)
        .sequence("pre", "work", { maxGap: 5 })
        .build(),
      activity("Debrief").rank(3).minutes(15).sequence("post", "work").build(),
    ]
    const manual: Activity[] = [
      {
        id: "work",
        name: "Work",
        durationMinutes: 480,
        priorityRank: 1,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "window",
            source: "template",
            days: ALL_WEEKDAYS,
            startWall: "09:00",
            endWall: "17:00",
            maxDriftMinutes: 0,
          },
        ],
      },
      {
        id: "commute",
        name: "Commute",
        durationMinutes: 30,
        priorityRank: 2,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "sequence",
            source: "template",
            role: "pre",
            linkedActivityId: "work",
            maxGapMinutes: 5,
          },
        ],
      },
      {
        id: "debrief",
        name: "Debrief",
        durationMinutes: 15,
        priorityRank: 3,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "sequence",
            source: "template",
            role: "post",
            linkedActivityId: "work",
            maxGapMinutes: 0,
          },
        ],
      },
    ]
    expectEquivalent(sugar, manual)
  })

  it("OverlapRule (guest nesting) and .days() eligibility restriction", () => {
    const sugar = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email"] })
        .build(),
      activity("Email").id("email").rank(2).minutes(30).build(),
      activity("Weekday Only").rank(3).minutes(30).days("MON").build(),
      activity("Weekend Only").rank(4).minutes(30).days("SAT", "SUN").build(),
    ]
    const manual: Activity[] = [
      {
        id: "work",
        name: "Work",
        durationMinutes: 480,
        priorityRank: 1,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "window",
            source: "template",
            days: ALL_WEEKDAYS,
            startWall: "09:00",
            endWall: "17:00",
            maxDriftMinutes: 0,
          },
          {
            type: "overlap",
            source: "template",
            budgetMinutes: 60,
            allowedGuestIds: ["email"],
            exclusionWindows: [],
          },
        ],
      },
      {
        id: "email",
        name: "Email",
        durationMinutes: 30,
        priorityRank: 2,
        enabled: true,
        requiredCount: 0,
        rules: [],
      },
      {
        id: "weekday-only",
        name: "Weekday Only",
        durationMinutes: 30,
        priorityRank: 3,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "window",
            source: "template",
            days: ["MON"],
            startWall: "00:00",
            endWall: "24:00",
            maxDriftMinutes: 0,
          },
        ],
      },
      {
        id: "weekend-only",
        name: "Weekend Only",
        durationMinutes: 30,
        priorityRank: 4,
        enabled: true,
        requiredCount: 0,
        rules: [
          {
            type: "window",
            source: "template",
            days: ["SAT", "SUN"],
            startWall: "00:00",
            endWall: "24:00",
            maxDriftMinutes: 0,
          },
        ],
      },
    ]
    expectEquivalent(sugar, manual)
  })
})
