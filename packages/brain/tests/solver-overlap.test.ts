import { describe, expect, it } from "vitest";

import { solveChecked as solve } from "./support/solve-checked";
import { resolveDayFrame } from "../src/engine/time";
import type { ExclusionWindow } from "../src/engine/types";
import { activity } from "./support/fixtures";
import { expectPlacements } from "./support/expect-placements";

const dayFrame = resolveDayFrame("2024-06-17", "UTC");

function generate(catalog: ReturnType<typeof activity>[]) {
  return solve({
    dayFrame,
    now: 0,
    catalog: catalog.map((b) => b.build()),
    existing: [],
    carryIn: [],
    event: { type: "GENERATE_DAY" },
  });
}

describe("solve — OverlapRule (nesting, SPEC.md 14.1's spirit)", () => {
  it("nests a lower-priority guest inside its already-placed host instead of taking standalone time", () => {
    // Email's own window (09:00-09:30) sits entirely inside Work's occupied
    // span, so no top-level slot can ever satisfy it — nesting is the only
    // way it gets placed at all.
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email"] }),
      activity("Email").id("email").rank(2).minutes(30).strict("09:00", "09:30"),
    ]);

    const email = result.timeline.instances.find((i) => i.name === "Email")!;
    expect(email.state).toBe("PLANNED");
    expect(email.hostInstanceId).toBe("work@2024-06-17#1");
    expect(email.plannedStart).toBe(540);
    expect(email.plannedEnd).toBe(570);

    // A nested guest doesn't occupy standalone top-level time: it isn't a
    // top-level instance at all (expectPlacements only looks at those).
    expectPlacements(result, { Work: "09:00-17:00" });
  });

  it("shares one budget across guests and exhausts it", () => {
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 40, guests: ["email", "call"] }),
      activity("Email").id("email").rank(2).minutes(20).strict("09:00", "09:20"),
      activity("Call").id("call").rank(3).minutes(20).strict("10:00", "10:20"),
    ]);

    const email = result.timeline.instances.find((i) => i.name === "Email")!;
    const call = result.timeline.instances.find((i) => i.name === "Call")!;
    expect(email.hostInstanceId).toBe("work@2024-06-17#1");
    expect(call.hostInstanceId).toBe("work@2024-06-17#1");

    const spent = email.scheduledMinutes + call.scheduledMinutes;
    expect(spent).toBe(40);
  });

  it("keeps guests from overlapping each other inside the same host", () => {
    // Both guests share the same 60-minute flexible window (zero drift, so
    // effectively pinned inside it) with room for exactly two 30-minute
    // blocks — proving the second guest's search excludes the first guest's
    // already-claimed slot rather than colliding with it.
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["a", "b"] }),
      activity("A").id("a").rank(2).minutes(30).flexible("09:00", "10:00", { drift: 0 }),
      activity("B").id("b").rank(3).minutes(30).flexible("09:00", "10:00", { drift: 0 }),
    ]);
    const a = result.timeline.instances.find((i) => i.name === "A")!;
    const b = result.timeline.instances.find((i) => i.name === "B")!;
    expect(a.hostInstanceId).toBe("work@2024-06-17#1");
    expect(b.hostInstanceId).toBe("work@2024-06-17#1");
    expect(a.plannedStart).toBe(540);
    expect(a.plannedEnd).toBe(570);
    expect(b.plannedStart).toBe(570);
    expect(b.plannedEnd).toBe(600);
  });

  it("blocks nesting inside a relative exclusion window", () => {
    const focusHour: ExclusionWindow = {
      id: "focus",
      name: "Focus Hour",
      anchor: "relative",
      startOffset: 0,
      endOffset: 480, // the entire host span is excluded
    };
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email"], exclusions: [focusHour] }),
      activity("Email").id("email").rank(2).minutes(30),
    ]);
    const email = result.timeline.instances.find((i) => i.name === "Email")!;
    expect(email.hostInstanceId).toBeNull();
  });
});

describe("solve — OverlapRule (greedy placement internals)", () => {
  it("nests a guest that also carries its own ShrinkRule", () => {
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["break"] }),
      activity("Break")
        .id("break")
        .rank(2)
        .minutes(40)
        .strict("09:00", "09:40")
        .shrink({ floor: 20 }),
    ]);
    const brk = result.timeline.instances.find((i) => i.name === "Break")!;
    expect(brk.hostInstanceId).toBe("work@2024-06-17#1");
    expect(brk.plannedStart).toBe(540);
    expect(brk.plannedEnd).toBe(580);
    expect(brk.scheduledMinutes).toBe(40);
  });

  it("can't nest a guest into a host that hasn't been placed yet at the guest's own turn", () => {
    // Early outranks Later, so by the time Early is greedily placed, Later
    // (its only eligible host) has no placement yet — nesting isn't
    // considered, and Early is placed standalone instead.
    const result = generate([
      activity("Early").id("early").rank(1).minutes(20),
      activity("Later")
        .id("later")
        .rank(2)
        .minutes(60)
        .overlap({ budget: 30, guests: ["early"] }),
    ]);
    const early = result.timeline.instances.find((i) => i.name === "Early")!;
    expect(early.hostInstanceId).toBeNull();
    expect(early.plannedStart).toBe(0);
    expect(early.plannedEnd).toBe(20);

    const later = result.timeline.instances.find((i) => i.name === "Later")!;
    expect(later.plannedStart).toBe(20);
  });

  it("picks the cheaper of two eligible hosts, replacing an earlier, costlier nested candidate", () => {
    // Note's own window matches Afternoon exactly (zero drift) but is fully
    // outside Morning's span (driftMinutes = its own full duration there,
    // same as standing alone) — Morning is evaluated first (catalog order)
    // and provisionally accepted, then Afternoon must replace it once found.
    const result = generate([
      activity("Morning")
        .rank(1)
        .minutes(60)
        .mandatory()
        .strict("09:00", "10:00")
        .overlap({ budget: 30, guests: ["note"] }),
      activity("Afternoon")
        .rank(2)
        .minutes(60)
        .mandatory()
        .strict("14:00", "15:00")
        .overlap({ budget: 30, guests: ["note"] }),
      activity("Note").id("note").rank(3).minutes(10).flexible("14:00", "14:10", { drift: 10 }),
    ]);
    const note = result.timeline.instances.find((i) => i.name === "Note")!;
    expect(note.hostInstanceId).toBe("afternoon@2024-06-17#1");
    expect(note.plannedStart).toBe(840);
    expect(note.plannedEnd).toBe(850);
    expect(note.relaxations).toEqual([]);
  });
});

describe("solve — OverlapRule (absolute exclusion, SPEC.md 5.7)", () => {
  it("rejects a host placement that doesn't fully contain an absolute exclusion window", () => {
    const customerCall: ExclusionWindow = {
      id: "call",
      name: "Customer Call",
      anchor: "absolute",
      startWall: "09:00",
      endWall: "10:00",
    };
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(60)
        .mandatory()
        .strict("09:15", "10:15") // never fully contains 09:00-10:00
        .overlap({ budget: 0, guests: [], exclusions: [customerCall] }),
    ]);
    expectPlacements(result, { Work: "SKIPPED" });
  });

  it("places the host so the absolute exclusion window falls entirely inside it (SPEC.md 14.7's spirit)", () => {
    const customerCall: ExclusionWindow = {
      id: "call",
      name: "Customer Call",
      anchor: "absolute",
      startWall: "09:00",
      endWall: "10:00",
    };
    const result = generate([
      activity("Work")
        .rank(1)
        .minutes(480)
        .mandatory()
        .strict("09:00", "17:00")
        .overlap({ budget: 60, guests: ["email"], exclusions: [customerCall] }),
      activity("Email").id("email").rank(2).minutes(30).strict("09:00", "10:00"), // exactly the excluded window — cannot nest
    ]);
    expectPlacements(result, { Work: "09:00-17:00", Email: "SKIPPED" });
    const email = result.timeline.instances.find((i) => i.name === "Email")!;
    expect(email.state).toBe("SKIPPED");
    expect(email.skipReason).toBe("WINDOW_UNSATISFIABLE");
  });
});
