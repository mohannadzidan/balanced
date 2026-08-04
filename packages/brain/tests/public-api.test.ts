import { describe, expect, it } from "vitest";

import { activity, resolveDayFrame, solve, validateCatalog } from "../src/brain";

describe("public API (src/brain.ts)", () => {
  it("builds a catalog and solves a day using only the barrel's exports", () => {
    const dayFrame = resolveDayFrame("2026-07-27", "UTC");
    const catalog = [
      activity("Gym").rank(1).minutes(60).flexible("18:00", "20:00", { drift: 15 }).build(),
      activity("Standup").rank(2).minutes(15).fixed("09:00", "09:15").build(),
    ];

    expect(validateCatalog(catalog)).toEqual([]);

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    });

    expect(result.status).toBe("OK");
    expect(result.timeline.instances.find((i) => i.name === "Standup")?.plannedStart).toBe(540);
  });
});
