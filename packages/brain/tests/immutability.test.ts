import { describe, expect, it } from "vitest";

import { solveChecked as solve } from "./support/solve-checked";
import { resolveDayFrame } from "../src/engine/time";
import { activity } from "./support/fixtures";

/**
 * Deep-freezes an object graph so any attempted mutation throws (ESM modules
 * always run in strict mode, so a write to a frozen property is a
 * TypeError, not a silent no-op) — SPEC.md 11 edge case 20: "the engine
 * must not mutate any input."
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

describe("solve — never mutates its input (SPEC.md 11, edge case 20)", () => {
  it("accepts deep-frozen catalog/existing/carryIn across GENERATE_DAY, TICK, SKIP, EXTEND, and a rejection", () => {
    const dayFrame = deepFreeze(resolveDayFrame("2024-06-17", "UTC"));
    const catalog = deepFreeze([
      activity("Work")
        .rank(1)
        .minutes(480)
        .strict("09:00", "18:00")
        .mandatory()
        .overlap({
          budget: 60,
          guests: ["email"],
          exclusions: [
            {
              id: "focus-hour",
              name: "Focus Hour",
              anchor: "relative",
              startOffset: 60,
              endOffset: 120,
            },
          ],
        })
        .build(),
      activity("Commute").rank(2).minutes(30).sequence("pre", "work").build(),
      activity("Gym")
        .rank(3)
        .minutes(60)
        .flexible("18:00", "20:00", { drift: 30 })
        .shrink({ floor: 45 })
        .build(),
      activity("Email").rank(4).minutes(30).build(),
    ]);

    expect(() =>
      solve({
        dayFrame,
        now: 0,
        catalog,
        existing: deepFreeze([]),
        carryIn: deepFreeze([]),
        event: deepFreeze({ type: "GENERATE_DAY" }),
      }),
    ).not.toThrow();

    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    });
    const existing = deepFreeze(generated.timeline.instances);
    const work = existing.find((i) => i.name === "Work")!;

    expect(() =>
      solve({
        dayFrame,
        now: 10,
        catalog,
        existing,
        carryIn: deepFreeze([]),
        event: deepFreeze({ type: "TICK" }),
        revision: generated.timeline.revision,
      }),
    ).not.toThrow();

    const gym = existing.find((i) => i.name === "Gym")!;
    expect(() =>
      solve({
        dayFrame,
        now: 0,
        catalog,
        existing,
        carryIn: [],
        event: deepFreeze({ type: "SKIP", instanceId: gym.id }),
        revision: generated.timeline.revision,
      }),
    ).not.toThrow();

    // A rejection (unknown instance) is a discarded path — it must not
    // mutate the frozen input either, and must still echo it back exactly.
    const rejected = solve({
      dayFrame,
      now: 0,
      catalog,
      existing,
      carryIn: [],
      event: deepFreeze({
        type: "EXTEND",
        instanceId: "does-not-exist",
        minutes: 5,
      }),
      revision: generated.timeline.revision,
    });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.timeline.instances).toEqual(existing);

    // Deep-frozen values throw on write, so simply reaching this point
    // without an uncaught TypeError already proves nothing was mutated;
    // this is the final check that the identity/values are still intact.
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(existing)).toBe(true);
    expect(work.plannedStart).not.toBeNull();
  });
});
