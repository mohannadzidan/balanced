import { describe, expect, it } from "vitest";

import { solveChecked as solve } from "./support/solve-checked";
import { resolveDayFrame } from "../src/engine/time";
import { activity } from "./support/fixtures";

const dayFrame = resolveDayFrame("2024-06-17", "UTC");

function activate(
  catalog: ReturnType<typeof activity>[],
  existing: Parameters<typeof solve>[0]["existing"],
  revision: number,
  now: number,
) {
  return solve({
    dayFrame,
    now,
    catalog: catalog.map((b) => b.build()),
    existing,
    carryIn: [],
    event: { type: "TICK" },
    revision,
  });
}

describe("solve — FINISH_EARLY (SPEC.md 9.3)", () => {
  it("completes the instance at `at` and frees the rest of its block for reuse", () => {
    const catalog = [activity("Work").rank(1).minutes(60), activity("Gym").rank(2).minutes(30)];
    const generated = solve({
      dayFrame,
      now: 0,
      catalog: catalog.map((b) => b.build()),
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }); // Work 00:00-01:00, Gym 01:00-01:30

    const active = activate(catalog, generated.timeline.instances, generated.timeline.revision, 10);
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!;
    expect(activeWork.state).toBe("ACTIVE");

    const finished = solve({
      dayFrame,
      now: 30,
      catalog: catalog.map((b) => b.build()),
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "FINISH_EARLY", instanceId: activeWork.id, at: 20 },
      revision: active.timeline.revision,
    });

    expect(finished.status).not.toBe("REJECTED");
    const finishedWork = finished.timeline.instances.find((i) => i.name === "Work")!;
    expect(finishedWork.state).toBe("COMPLETED");
    expect(finishedWork.completedSource).toBe("user");
    expect(finishedWork.actualStart).toBe(0);
    expect(finishedWork.actualEnd).toBe(20);

    // Gym was previously placed right after Work's full hour (01:00); with
    // Work now freed from 20 onward, Gym should slide up to fill it.
    const gym = finished.timeline.instances.find((i) => i.name === "Gym")!;
    expect(gym.plannedStart).toBe(20);
    expect(gym.plannedEnd).toBe(50);
    expect(finished.timeline.revision).toBe(active.timeline.revision + 1);
  });

  it("restores a previously-skipped lower priority activity once time frees up", () => {
    const catalog = [activity("Work").rank(1).minutes(60), activity("Errand").rank(2).minutes(40)];
    const generated = solve({
      dayFrame,
      now: 0,
      catalog: catalog.map((b) => b.build()),
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    }); // Work 00:00-01:00, Errand 01:00-01:40
    const active = activate(catalog, generated.timeline.instances, generated.timeline.revision, 5);
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!;

    const finished = solve({
      dayFrame,
      now: 15,
      catalog: catalog.map((b) => b.build()),
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "FINISH_EARLY", instanceId: activeWork.id, at: 10 },
      revision: active.timeline.revision,
    });

    const errand = finished.timeline.instances.find((i) => i.name === "Errand")!;
    expect(errand.state).toBe("PLANNED");
    expect(errand.plannedStart).toBe(10);
    expect(errand.plannedEnd).toBe(50);
  });

  it("rejects with UNKNOWN_INSTANCE for an id that isn't in the timeline", () => {
    const result = solve({
      dayFrame,
      now: 0,
      catalog: [],
      existing: [],
      carryIn: [],
      event: { type: "FINISH_EARLY", instanceId: "nope", at: 0 },
    });
    expect(result.status).toBe("REJECTED");
    expect(result.rejection?.code).toBe("UNKNOWN_INSTANCE");
  });

  it("rejects with INVALID_STATE_FOR_EVENT when the instance isn't ACTIVE", () => {
    const catalog = [activity("Work").rank(1).minutes(60).build()];
    const generated = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    });
    const work = generated.timeline.instances.find((i) => i.name === "Work")!;

    const result = solve({
      dayFrame,
      now: 0,
      catalog,
      existing: generated.timeline.instances,
      carryIn: [],
      event: { type: "FINISH_EARLY", instanceId: work.id, at: 30 },
      revision: generated.timeline.revision,
    });
    expect(result.status).toBe("REJECTED");
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT");
  });

  it("rejects with INVALID_STATE_FOR_EVENT when `at` is after the planned end", () => {
    const catalog = [activity("Work").rank(1).minutes(60)];
    const generated = solve({
      dayFrame,
      now: 0,
      catalog: catalog.map((b) => b.build()),
      existing: [],
      carryIn: [],
      event: { type: "GENERATE_DAY" },
    });
    const active = activate(catalog, generated.timeline.instances, generated.timeline.revision, 10);
    const activeWork = active.timeline.instances.find((i) => i.name === "Work")!;

    const result = solve({
      dayFrame,
      now: 10,
      catalog: catalog.map((b) => b.build()),
      existing: active.timeline.instances,
      carryIn: [],
      event: { type: "FINISH_EARLY", instanceId: activeWork.id, at: 120 },
      revision: active.timeline.revision,
    });
    expect(result.status).toBe("REJECTED");
    expect(result.rejection?.code).toBe("INVALID_STATE_FOR_EVENT");
  });
});
