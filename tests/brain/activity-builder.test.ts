import { describe, expect, it } from "vitest"

import { activity, ActivityBuilder } from "@/app/brain/engine/activity-builder"

describe("ActivityBuilder", () => {
  it("throws when built without a priority rank", () => {
    expect(() => activity("Untitled").build()).toThrow(/missing \.rank\(n\)/)
  })

  it("applies sensible defaults for everything but the id and rank", () => {
    const built = activity("Morning Run").rank(2).build()
    expect(built).toEqual({
      id: "morning-run",
      name: "Morning Run",
      durationMinutes: 30,
      priorityRank: 2,
      enabled: true,
      rules: [],
    })
  })

  it("lets .id() override the auto-slugified id", () => {
    const built = activity("Morning Run").id("run").rank(1).build()
    expect(built.id).toBe("run")
  })

  it("marks the activity disabled", () => {
    const built = activity("Gym").rank(1).disabled().build()
    expect(built.enabled).toBe(false)
  })

  it("adds a sequence rule with a default zero max gap", () => {
    const built = activity("Cooldown").rank(1).sequence("post", "run").build()
    expect(built.rules).toEqual([
      {
        type: "sequence",
        source: "template",
        role: "post",
        linkedActivityId: "run",
        maxGapMinutes: 0,
      },
    ])
  })

  it("adds an overlap rule with defaulted exclusion windows", () => {
    const built = activity("Work")
      .rank(1)
      .overlap({ budget: 30, guests: ["email"] })
      .build()
    expect(built.rules).toEqual([
      {
        type: "overlap",
        source: "template",
        budgetMinutes: 30,
        allowedGuestIds: ["email"],
        exclusionWindows: [],
      },
    ])
  })

  it("is reusable as a class directly, not just via the activity() factory", () => {
    const built = new ActivityBuilder("Direct").rank(1).build()
    expect(built.name).toBe("Direct")
  })
})
