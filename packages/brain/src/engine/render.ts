import type { Timeline } from "./types";

function fmt(minutesFromMidnight: number): string {
  const total = ((minutesFromMidnight % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Pure formatting from a Timeline to a deterministic ASCII string.
 * No timestamps or elapsed-time counters — every byte is derived from the
 * timeline value itself, so it is safe to use as a snapshot assertion.
 */
export function renderAscii(timeline: Timeline): string {
  const lines: string[] = [];
  const topLevel = timeline.instances.filter((i) => i.hostInstanceId === null);
  const placed = topLevel
    .filter((i) => i.state !== "SKIPPED")
    .slice()
    .sort((a, b) => (a.plannedStart ?? 0) - (b.plannedStart ?? 0));
  const skipped = topLevel
    .filter((i) => i.state === "SKIPPED")
    .slice()
    .sort((a, b) => a.priorityRank - b.priorityRank);

  for (const inst of [...placed, ...skipped]) {
    if (inst.state === "SKIPPED") {
      const reason = inst.skipReason ? ` — ${inst.skipReason}` : "";
      lines.push(`      ✗ ${inst.name}  SKIPPED${reason}`);
      continue;
    }

    const start = inst.plannedStart ?? 0;
    const end = inst.plannedEnd ?? start;
    const relaxNote =
      inst.relaxations.length > 0
        ? `  (${inst.relaxations.map((r) => `${r.type} ${r.minutes}m`).join(", ")})`
        : "";
    lines.push(
      `${fmt(start)} ├ ${inst.name}  ${end - start}m  ${fmt(start)}-${fmt(end)}${relaxNote}`,
    );

    const guests = timeline.instances
      .filter((g) => g.hostInstanceId === inst.id)
      .sort((a, b) => (a.plannedStart ?? 0) - (b.plannedStart ?? 0));
    for (const g of guests) {
      const gs = g.plannedStart ?? 0;
      const ge = g.plannedEnd ?? gs;
      lines.push(`      │   └ ${fmt(gs)}-${fmt(ge)}   ${g.name}`);
    }
  }

  const c = timeline.cost;
  lines.push("");
  lines.push(
    `cost: total ${c.total} | skip ${c.skip} | shrink ${c.shrink} | chunk ${c.chunk} | drift ${c.drift} | gap ${c.gap} | idle ${c.idle}`,
  );
  lines.push(`status: ${timeline.status}`);
  return lines.join("\n");
}
