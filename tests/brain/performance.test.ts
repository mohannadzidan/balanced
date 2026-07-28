import { describe, expect, it } from "vitest"

import { solve } from "@/app/brain/engine/solve"
import { resolveDayFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

const dayFrame = resolveDayFrame("2024-06-17", "UTC")

// SPEC-v2.md Section 12.1 acceptance criterion 6 / SPEC.md Section 16.3
// criterion 7: "a full solve of a 20-activity day still completes in under
// 100 ms." The threshold here is 10x that (generous margin against CI
// scheduling jitter) — this is a regression smoke test for an accidental
// algorithmic blowup, not a tight performance benchmark.
describe("solve — performance (SPEC-v2.md 12.1 criterion 6)", () => {
  it("solves a 20-activity day comfortably under 1000ms", () => {
    const catalog = [
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email", "call"] })
        .build(),
      activity("Email")
        .id("email")
        .rank(2)
        .minutes(15)
        .strict("09:00", "09:15")
        .build(),
      activity("Call")
        .id("call")
        .rank(3)
        .minutes(15)
        .strict("10:00", "10:15")
        .build(),
      activity("Commute Morning")
        .rank(4)
        .minutes(30)
        .sequence("pre", "work")
        .build(),
      activity("Commute Evening")
        .rank(5)
        .minutes(30)
        .sequence("post", "work")
        .build(),
      activity("Standup").rank(6).minutes(15).fixed("09:00", "09:15").build(),
      activity("Gym")
        .rank(7)
        .minutes(60)
        .flexible("18:00", "20:00", { drift: 30 })
        .shrink({ floor: 30 })
        .build(),
      activity("Reading")
        .rank(8)
        .minutes(45)
        .flexible("20:00", "22:00", { drift: 30 })
        .shrink({ floor: 15 })
        .build(),
      activity("Breakfast")
        .rank(9)
        .minutes(20)
        .flexible("07:00", "08:00", { drift: 15 })
        .build(),
      activity("Lunch")
        .rank(10)
        .minutes(30)
        .flexible("12:00", "13:30", { drift: 30 })
        .build(),
      activity("Dinner")
        .rank(11)
        .minutes(40)
        .flexible("19:00", "21:00", { drift: 30 })
        .build(),
      activity("Meditation")
        .rank(12)
        .minutes(15)
        .flexible("06:30", "08:00", { drift: 20 })
        .build(),
      activity("Errand One")
        .rank(13)
        .minutes(25)
        .flexible("11:00", "16:00", { drift: 60 })
        .build(),
      activity("Errand Two")
        .rank(14)
        .minutes(25)
        .flexible("11:00", "16:00", { drift: 60 })
        .build(),
      activity("Journal")
        .rank(15)
        .minutes(10)
        .flexible("21:00", "23:00", { drift: 60 })
        .build(),
      activity("Planning")
        .rank(16)
        .minutes(20)
        .flexible("07:00", "09:00", { drift: 60 })
        .build(),
      activity("Stretch")
        .rank(17)
        .minutes(10)
        .flexible("17:00", "19:00", { drift: 60 })
        .build(),
      activity("Call Family")
        .rank(18)
        .minutes(20)
        .flexible("18:00", "21:00", { drift: 90 })
        .build(),
      activity("Tidy Up")
        .rank(19)
        .minutes(15)
        .flexible("21:00", "22:30", { drift: 60 })
        .build(),
      activity("Wind Down")
        .rank(20)
        .minutes(20)
        .flexible("22:00", "23:30", { drift: 60 })
        .build(),
    ]

    const start = performance.now()
    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    })
    const elapsedMs = performance.now() - start

    expect(result.status).not.toBe("REJECTED")
    expect(result.timeline.instances.length).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(1000)
  })
})
