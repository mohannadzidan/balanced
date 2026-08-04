import type { Activity, RepeatRule, Timeline, TimelineActivity } from "./types";
import { GRID } from "./constants";
import { resolveWindows } from "./resolve";

export type InvariantCode =
  | "INVARIANT_1_NO_TOP_LEVEL_OVERLAP"
  | "INVARIANT_2_GUEST_INSIDE_HOST"
  | "INVARIANT_3_GUESTS_NON_OVERLAPPING"
  | "INVARIANT_4_GUEST_AVOIDS_EXCLUSION"
  | "INVARIANT_5_GUEST_BUDGET"
  | "INVARIANT_6_SCHEDULED_WITHIN_BOUNDS"
  | "INVARIANT_7_GRID_ALIGNMENT"
  | "INVARIANT_8_NO_START_BEFORE_FROZEN"
  | "INVARIANT_9_EXCLUSION_NO_COST"
  | "INVARIANT_10_ONE_OCCURRENCE_ONE_BUCKET"
  | "INVARIANT_11_BUCKET_COUNT_CAP"
  | "INVARIANT_12_SIBLING_SEPARATION"
  | "INVARIANT_13_WITHIN_ELIGIBLE_DAY_SPAN"
  | "INVARIANT_14_UNIQUE_OCCURRENCE_ID";

export interface InvariantViolation {
  readonly code: InvariantCode;
  readonly instanceIds: readonly string[];
  readonly message: string;
}

/** SPEC.md §4.5 / §16.1 layer 4: structural invariants that must hold on every timeline. */
export function checkInvariants(timeline: Timeline): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const instances = timeline.instances;

  // Invariant 1: Top-level blocks never overlap each other.
  // Top-level = not a guest (hostInstanceId === null)
  // Use effective end = actualEnd ?? plannedEnd to handle FINISH_EARLY cases
  // where a block's actual consumption is shorter than its planned span.
  const effectiveEnd = (i: TimelineActivity): number | null => {
    if (i.plannedStart === null || i.plannedEnd === null) return null;
    if (i.actualEnd !== null) return i.actualEnd;
    return i.plannedEnd;
  };
  const topLevel = instances.filter((i) => i.hostInstanceId === null);
  for (let a = 0; a < topLevel.length; a++) {
    for (let b = a + 1; b < topLevel.length; b++) {
      const ia = topLevel[a];
      const ib = topLevel[b];
      const iaEnd = effectiveEnd(ia);
      const ibEnd = effectiveEnd(ib);
      if (
        ia.plannedStart !== null &&
        iaEnd !== null &&
        ib.plannedStart !== null &&
        ibEnd !== null
      ) {
        if (ia.plannedStart < ibEnd && ib.plannedStart < iaEnd) {
          violations.push({
            code: "INVARIANT_1_NO_TOP_LEVEL_OVERLAP",
            instanceIds: [ia.id, ib.id],
            message: `Top-level instances ${ia.name} (${ia.id}) and ${ib.name} (${ib.id}) overlap`,
          });
        }
      }
    }
  }

  // Helper: build host -> guests map
  const guestsByHost = new Map<string, TimelineActivity[]>();
  for (const inst of instances) {
    if (inst.hostInstanceId !== null) {
      const arr = guestsByHost.get(inst.hostInstanceId) || [];
      arr.push(inst);
      guestsByHost.set(inst.hostInstanceId, arr);
    }
  }

  // Invariant 2: A guest block lies entirely within its host's placement.
  // Invariant 3: Guests of the same host never overlap each other.
  // Invariant 4: No guest intersects any exclusion window of its host.
  // Invariant 5: Sum of guest durations per host ≤ that host's overlap budget.
  for (const host of instances) {
    const guests = guestsByHost.get(host.id);
    if (!guests || guests.length === 0) continue;

    const hostStart = host.plannedStart;
    const hostEnd = host.plannedEnd;
    if (hostStart === null || hostEnd === null) continue;

    // Invariant 2
    for (const guest of guests) {
      if (guest.plannedStart === null || guest.plannedEnd === null) continue;
      if (guest.plannedStart < hostStart || guest.plannedEnd > hostEnd) {
        violations.push({
          code: "INVARIANT_2_GUEST_INSIDE_HOST",
          instanceIds: [guest.id, host.id],
          message: `Guest ${guest.name} (${guest.id}) not fully inside host ${host.name} (${host.id})`,
        });
      }
    }

    // Invariant 3
    for (let a = 0; a < guests.length; a++) {
      for (let b = a + 1; b < guests.length; b++) {
        const ga = guests[a];
        const gb = guests[b];
        if (
          ga.plannedStart !== null &&
          ga.plannedEnd !== null &&
          gb.plannedStart !== null &&
          gb.plannedEnd !== null
        ) {
          if (ga.plannedStart < gb.plannedEnd && gb.plannedStart < ga.plannedEnd) {
            violations.push({
              code: "INVARIANT_3_GUESTS_NON_OVERLAPPING",
              instanceIds: [ga.id, gb.id, host.id],
              message: `Guests ${ga.name} (${ga.id}) and ${gb.name} (${gb.id}) of host ${host.name} (${host.id}) overlap`,
            });
          }
        }
      }
    }

    // Invariant 4 & 5: need OverlapRule from host
    const overlapRule = host.rules.find(
      (r): r is import("./types").OverlapRule => r.type === "overlap",
    );
    if (!overlapRule) continue;

    // Exclusion windows
    for (const guest of guests) {
      if (guest.plannedStart === null || guest.plannedEnd === null) continue;
      for (const ew of overlapRule.exclusionWindows) {
        const ewStart =
          ew.anchor === "absolute"
            ? ew.startWall !== undefined
              ? minutesOfDay(ew.startWall)
              : 0
            : (hostStart ?? 0) + (ew.startOffset ?? 0);
        const ewEnd =
          ew.anchor === "absolute"
            ? ew.endWall !== undefined
              ? minutesOfDay(ew.endWall)
              : 0
            : (hostStart ?? 0) + (ew.endOffset ?? 0);

        if (guest.plannedStart < ewEnd && ewStart < guest.plannedEnd) {
          violations.push({
            code: "INVARIANT_4_GUEST_AVOIDS_EXCLUSION",
            instanceIds: [guest.id, host.id],
            message: `Guest ${guest.name} (${guest.id}) intersects exclusion window of host ${host.name} (${host.id})`,
          });
        }
      }
    }

    // Invariant 5: guest budget
    let guestBudget = 0;
    for (const guest of guests) {
      guestBudget += guest.scheduledMinutes;
    }
    if (guestBudget > overlapRule.budgetMinutes) {
      violations.push({
        code: "INVARIANT_5_GUEST_BUDGET",
        instanceIds: [host.id],
        message: `Host ${host.name} (${host.id}) guest budget ${guestBudget}m exceeds overlap budget ${overlapRule.budgetMinutes}m`,
      });
    }
  }

  // Invariant 6: For every instance: scheduled_minutes ≤ duration_minutes,
  // and if scheduled at all, scheduled_minutes ≥ shrink floor.
  // Exceptions:
  // - spanning blocks (plannedEnd > lengthMinutes) — Drop-2 deletion territory.
  // - extended blocks (scheduledMinutes > durationMinutes but no shrink relaxation
  //   and the instance is ACTIVE/COMPLETED): user EXTEND is a legitimate source
  //   of duration inflation per SPEC.md §9.4.
  // - chunked blocks: a chunk's own scheduled_minutes must be ≥ minBlockMinutes
  //   (per-chunk floor); the total-floor check is per-activity, not per-chunk.
  const hasShrinkRelaxation = (i: TimelineActivity) =>
    i.relaxations.some((r) => r.type === "shrink");
  for (const inst of instances) {
    const isSpanning =
      inst.plannedStart !== null &&
      inst.plannedEnd !== null &&
      inst.plannedEnd > timeline.dayFrame.lengthMinutes;
    const isExtended = inst.scheduledMinutes > inst.durationMinutes && !hasShrinkRelaxation(inst);
    if (inst.scheduledMinutes > inst.durationMinutes && !isSpanning && !isExtended) {
      violations.push({
        code: "INVARIANT_6_SCHEDULED_WITHIN_BOUNDS",
        instanceIds: [inst.id],
        message: `Instance ${inst.name} (${inst.id}) scheduled ${inst.scheduledMinutes}m exceeds duration ${inst.durationMinutes}m`,
      });
    }
    const elasticityRule = inst.rules.find(
      (r): r is import("./types").ElasticityRule => r.type === "elasticity",
    );
    if (!elasticityRule || inst.scheduledMinutes === 0) continue;
    // Per-chunk floor: each block must be ≥ minBlockMinutes (not minTotalMinutes,
    // which is the activity-wide total and is naturally satisfied by the chunk
    // group's sum, not each individual chunk).
    if (inst.scheduledMinutes < elasticityRule.minBlockMinutes) {
      violations.push({
        code: "INVARIANT_6_SCHEDULED_WITHIN_BOUNDS",
        instanceIds: [inst.id],
        message: `Instance ${inst.name} (${inst.id}) scheduled ${inst.scheduledMinutes}m below per-chunk floor ${elasticityRule.minBlockMinutes}m`,
      });
    }
  }

  // Invariant 7: Every placement start and end is a multiple of GRID.
  for (const inst of instances) {
    if (inst.plannedStart !== null && inst.plannedStart % GRID !== 0) {
      violations.push({
        code: "INVARIANT_7_GRID_ALIGNMENT",
        instanceIds: [inst.id],
        message: `Instance ${inst.name} (${inst.id}) plannedStart ${inst.plannedStart} not on GRID (${GRID})`,
      });
    }
    if (inst.plannedEnd !== null && inst.plannedEnd % GRID !== 0) {
      violations.push({
        code: "INVARIANT_7_GRID_ALIGNMENT",
        instanceIds: [inst.id],
        message: `Instance ${inst.name} (${inst.id}) plannedEnd ${inst.plannedEnd} not on GRID (${GRID})`,
      });
    }
  }

  // Invariant 8: No block starts before the end of the frozen region.
  // freezeBoundary = max over anchors (COMPLETED actualEnd, ACTIVE plannedEnd, CARRIED_IN plannedEnd).
  // Exempt: ACTIVE/COMPLETED/CARRIED_IN/SKIPPED instances (anchors), locked instances,
  // and spanning blocks (plannedEnd > lengthMinutes) — the latter is Drop-2 deletion territory.
  // For COMPLETED instances, use actualEnd (which may be < plannedEnd when user finished early).
  const anchorEnd = instances
    .filter((i) => i.state === "COMPLETED" || i.state === "ACTIVE" || i.state === "CARRIED_IN")
    .reduce((max, i) => {
      // For COMPLETED, actualEnd is authoritative (may be < plannedEnd via FINISH_EARLY).
      if (i.state === "COMPLETED" && i.actualEnd !== null) return Math.max(max, i.actualEnd);
      // For ACTIVE, plannedEnd (actualEnd may be null while in-progress).
      if (i.state === "ACTIVE") return Math.max(max, i.plannedEnd ?? 0);
      // For CARRIED_IN, plannedEnd.
      if (i.state === "CARRIED_IN") return Math.max(max, i.plannedEnd ?? 0);
      return max;
    }, 0);
  // Use anchorEnd alone — not max(solvedAtOffset, anchorEnd). solvedAtOffset is
  // input.now, but FINISH_EARLY can move the actual freeze boundary backwards
  // (to event.at, which may be < now). The engine's true freeze boundary is
  // the larger of consumed time and event.at, which anchorEnd captures.
  const effectiveFreeze = anchorEnd;
  for (const inst of instances) {
    if (
      inst.state !== "PLANNED" ||
      inst.locked ||
      inst.plannedStart === null ||
      inst.hostInstanceId !== null // guests inherit their host's span; not a new placement
    ) {
      continue;
    }
    const isSpanning =
      inst.plannedEnd !== null && inst.plannedEnd > timeline.dayFrame.lengthMinutes;
    if (isSpanning) continue;
    if (inst.plannedStart < effectiveFreeze) {
      violations.push({
        code: "INVARIANT_8_NO_START_BEFORE_FROZEN",
        instanceIds: [inst.id],
        message: `Instance ${inst.name} (${inst.id}) starts at ${inst.plannedStart} before freeze boundary ${effectiveFreeze}`,
      });
    }
  }

  // Invariant 9: Exclusion windows consume no duration and no overlap budget.
  // This is a structural property — verified by the fact that exclusion windows
  // are never added to scheduledMinutes or guestBudget above. No runtime check
  // needed; the invariant is that the solver never counts them. We assert that
  // no instance's relaxations or scheduledMinutes include exclusion window time.
  for (const inst of instances) {
    if (inst.hostInstanceId !== null) continue; // guests checked via budget above
    const overlapRule = inst.rules.find(
      (r): r is import("./types").OverlapRule => r.type === "overlap",
    );
    if (!overlapRule) continue;
    // Exclusion windows should not contribute to scheduledMinutes or budget.
    // The check in Invariant 5 already ensures budget only counts guest durations.
    // This is a design-time assertion: no code path adds exclusion time to either.
  }

  // Invariants 10 & 14 (SPEC-v2.1 §14): occurrenceId must be a consistent,
  // injective identifier for (activity, bucket, index). Blocks sharing an
  // occurrenceId (chunks of one occurrence) must agree on activity and
  // bucket (10); and must also agree on occurrenceIndex, so a generation bug
  // can't silently collide two distinct occurrences onto the same id (14).
  const byOccurrenceId = new Map<string, TimelineActivity[]>();
  for (const inst of instances) {
    const group = byOccurrenceId.get(inst.occurrenceId) ?? [];
    group.push(inst);
    byOccurrenceId.set(inst.occurrenceId, group);
  }
  for (const group of byOccurrenceId.values()) {
    const first = group[0];
    for (const inst of group.slice(1)) {
      if (inst.activityId !== first.activityId || inst.bucketKey !== first.bucketKey) {
        violations.push({
          code: "INVARIANT_10_ONE_OCCURRENCE_ONE_BUCKET",
          instanceIds: [first.id, inst.id],
          message: `Instances ${first.id} and ${inst.id} share occurrenceId ${first.occurrenceId} but disagree on activity/bucket`,
        });
      }
      if (inst.occurrenceIndex !== first.occurrenceIndex) {
        violations.push({
          code: "INVARIANT_14_UNIQUE_OCCURRENCE_ID",
          instanceIds: [first.id, inst.id],
          message: `Instances ${first.id} and ${inst.id} share occurrenceId ${first.occurrenceId} but are distinct occurrences (index ${first.occurrenceIndex} vs ${inst.occurrenceIndex})`,
        });
      }
    }
  }

  // Invariant 11 (SPEC-v2.1 §14): no bucket holds more occurrences of an
  // activity than its recurrence RepeatRule's count. The quota ledger
  // (`Plan.quotas`, "count - quotaPlaced") isn't wired in until Step 6, so
  // until then the cap is just `count` (no earlier carry-over solve has
  // placed any of it yet).
  const occurrenceIdsByActivityBucket = new Map<string, Set<string>>();
  const rulesByActivityId = new Map<string, readonly TimelineActivity["rules"][number][]>();
  for (const inst of instances) {
    if (inst.hostInstanceId !== null || inst.activityId === null) continue;
    const key = `${inst.activityId} ${inst.bucketKey}`;
    const set = occurrenceIdsByActivityBucket.get(key) ?? new Set<string>();
    set.add(inst.occurrenceId);
    occurrenceIdsByActivityBucket.set(key, set);
    rulesByActivityId.set(inst.activityId, inst.rules);
  }
  for (const [key, occurrenceIds] of occurrenceIdsByActivityBucket) {
    const [activityId, bucketKey] = key.split(" ");
    const rules = rulesByActivityId.get(activityId) ?? [];
    const recurrence = rules.find((r): r is RepeatRule => r.type === "repeat" && !r.sharedBudget);
    const cap = recurrence ? recurrence.count : 1;
    if (occurrenceIds.size > cap) {
      const ids = instances.filter((i) => occurrenceIds.has(i.occurrenceId)).map((i) => i.id);
      violations.push({
        code: "INVARIANT_11_BUCKET_COUNT_CAP",
        instanceIds: ids,
        message: `Bucket ${bucketKey} holds ${occurrenceIds.size} occurrences of ${activityId}, exceeding its RepeatRule count ${cap}`,
      });
    }
  }

  // Invariant 12 (SPEC-v2.1 §14): sibling occurrences respect
  // `minSeparationMinutes`, start to start. Gather every top-level
  // instance's minSeparationMinutes from its activity's RepeatRule and
  // check pairwise distance among instances with matching
  // `occurrenceId`-prefix (same activity, same bucket). Reads the rule
  // straight off the instance so the check stays independent of the
  // placeWithElasticity/placeHardSet filter that just ran.
  const minSepByInstanceId = new Map<string, number>();
  const activityOfInstanceId = new Map<string, TimelineActivity>();
  for (const inst of instances) {
    if (inst.hostInstanceId !== null) continue;
    if (inst.activityId === null) continue;
    activityOfInstanceId.set(inst.id, inst);
    const rule = inst.rules.find(
      (r): r is import("./types").RepeatRule => r.type === "repeat" && !r.sharedBudget,
    );
    if (rule && rule.minSeparationMinutes > 0) {
      minSepByInstanceId.set(inst.id, rule.minSeparationMinutes);
    }
  }
  for (let i = 0; i < instances.length; i++) {
    const a = instances[i];
    if (!minSepByInstanceId.has(a.id)) continue;
    if (a.plannedStart === null || a.bucketKey === undefined) continue;
    for (let j = i + 1; j < instances.length; j++) {
      const b = instances[j];
      if (!minSepByInstanceId.has(b.id)) continue;
      if (a.activityId !== b.activityId || a.bucketKey !== b.bucketKey) continue;
      if (b.plannedStart === null) continue;
      const minSep = Math.max(minSepByInstanceId.get(a.id)!, minSepByInstanceId.get(b.id)!);
      if (Math.abs(a.plannedStart - b.plannedStart) < minSep) {
        violations.push({
          code: "INVARIANT_12_SIBLING_SEPARATION",
          instanceIds: [a.id, b.id],
          message: `Siblings ${a.name} (${a.id}) and ${b.name} (${b.id}) start ${Math.abs(a.plannedStart - b.plannedStart)}m apart, less than the ${minSep}m required`,
        });
      }
    }
  }

  // Invariant 13 (SPEC-v2.1 §14): every placement lies within the union of
  // its eligible day spans. Independently re-resolves the same windows
  // `evaluateCandidate` enforces at solve time (SPEC-v2.1 §4), so a
  // placement bug and its detection don't share the same computation.
  for (const inst of instances) {
    if (inst.hostInstanceId !== null) continue; // guests inherit their host's span
    if (inst.plannedStart === null || inst.plannedEnd === null) continue;
    // Spanning blocks (plannedEnd > frame length) are Drop-2 deletion
    // territory — the same exemption Invariants 6 and 8 make above, for
    // the same reason: a FixedRule crossing the frame's last midnight
    // legitimately extends past lengthMinutes under Drop 1's carry-in
    // mechanism, which Step 6 replaces.
    if (inst.plannedEnd > timeline.dayFrame.lengthMinutes) continue;
    const pseudoActivity = { rules: inst.rules } as Activity;
    const windows = resolveWindows(pseudoActivity, timeline.dayFrame);
    if (windows.length === 0) continue; // unconstrained: no day-span restriction

    const spans = windows
      .map((w) => ({ start: w.daySpanStart, end: w.daySpanEnd }))
      .sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    const contained = merged.some(
      (m) => inst.plannedStart! >= m.start && inst.plannedEnd! <= m.end,
    );
    if (!contained) {
      violations.push({
        code: "INVARIANT_13_WITHIN_ELIGIBLE_DAY_SPAN",
        instanceIds: [inst.id],
        message: `Instance ${inst.name} (${inst.id}) placed at [${inst.plannedStart}, ${inst.plannedEnd}) outside its eligible day span`,
      });
    }
  }

  return violations;
}

function minutesOfDay(wall: string): number {
  const [h, m] = wall.split(":").map(Number);
  return h * 60 + m;
}
