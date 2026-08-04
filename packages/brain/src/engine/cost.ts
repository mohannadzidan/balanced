import { computeFreeIntervals, intervalLength } from "./intervals";
import type {
  Activity,
  CostBreakdown,
  CostConstants,
  ElasticityRule,
  RepeatRule,
  SequenceRule,
  TimelineActivity,
  WindowRule,
} from "./types";

/** W(a) = R + 1 − r, where r is the activity's rank in a catalogue of R ranked activities. */
export function priorityWeight(rank: number, totalRanked: number): number {
  return totalRanked + 1 - rank;
}

export interface CandidateEvaluation {
  readonly scheduledMinutes: number;
  readonly chunkCount: number;
  readonly driftMinutes: number;
  readonly gapMinutes: number;
}

/**
 * Cost of one candidate placement (SPEC.md Section 7.3), excluding idle.
 * Used to choose among candidates during single-activity placement search.
 */
export function placementCost(
  durationMinutes: number,
  weight: number,
  evaluation: CandidateEvaluation,
  constants: CostConstants,
): number {
  const unscheduled = Math.max(0, durationMinutes - evaluation.scheduledMinutes);
  return (
    weight * constants.SHRINK * unscheduled +
    weight * constants.CHUNK * Math.max(0, evaluation.chunkCount - 1) +
    weight * constants.DRIFT * evaluation.driftMinutes +
    weight * constants.GAP * evaluation.gapMinutes
  );
}

export function skipCost(
  weight: number,
  constants: CostConstants,
  opts: { readonly isRequired: boolean; readonly isDependentSkip: boolean },
): number {
  if (opts.isDependentSkip) return 0;
  if (opts.isRequired) return Number.POSITIVE_INFINITY;
  return weight * constants.SKIP;
}

function sumRelaxation(
  relaxations: TimelineActivity["relaxations"],
  type: "drift" | "gap",
): number {
  return relaxations.filter((r) => r.type === type).reduce((sum, r) => sum + r.minutes, 0);
}

function computeIdleMinutes(instances: readonly TimelineActivity[], lengthMinutes: number): number {
  const occupied = instances
    .filter((i) => i.hostInstanceId === null && i.plannedStart !== null && i.plannedEnd !== null)
    .map((i) => ({
      start: i.plannedStart as number,
      end: i.plannedEnd as number,
    }));
  const free = computeFreeIntervals(occupied, 0, lengthMinutes);
  return free.reduce((sum, iv) => sum + intervalLength(iv), 0);
}

/**
 * Whole-timeline cost (SPEC.md Section 7.5): sum of placement costs, skip
 * costs, and idle. Derived entirely from the instances' own recorded
 * relaxations — no need for the originating Activity catalogue.
 *
 * A chunked activity spans several top-level instances sharing one
 * `chunkGroupId`; its shrink/chunk/drift/gap terms are priced once for the
 * whole group (SPEC.md Section 7.3 prices the activity's plan, not each
 * fragment) rather than once per chunk, or a 2-chunk plan would be charged
 * its chunk-count penalty and shrink shortfall twice over.
 */
export function scheduleCost(
  instances: readonly TimelineActivity[],
  lengthMinutes: number,
  totalRanked: number,
  constants: CostConstants,
): CostBreakdown {
  let skip = 0;
  let shrink = 0;
  let chunk = 0;
  let drift = 0;
  let gap = 0;
  const perInstance: Record<string, number> = {};

  const groups = new Map<string, TimelineActivity[]>();
  for (const inst of instances) {
    const key = inst.chunkGroupId ?? inst.id;
    const group = groups.get(key);
    if (group) group.push(inst);
    else groups.set(key, [inst]);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.blockIndex - b.blockIndex);
    const [primary, ...rest] = group;
    const weight = priorityWeight(primary.priorityRank, totalRanked);
    let groupCost: number;

    if (primary.state === "SKIPPED") {
      // SPEC-v2.md Section 5.2: isRequired = occurrenceIndex < requiredCount.
      // Drop 1's occurrenceIndex is always 0, so this is requiredCount > 0.
      const isRequired = primary.requiredCount > 0;
      const isDependentSkip = primary.skipReason === "HOST_SKIPPED";
      groupCost = skipCost(weight, constants, { isRequired, isDependentSkip });
      skip += groupCost;
    } else {
      const scheduledMinutes = group.reduce((sum, i) => sum + i.scheduledMinutes, 0);
      const unscheduled = Math.max(0, primary.durationMinutes - scheduledMinutes);
      const driftMinutes = group.reduce((sum, i) => sum + sumRelaxation(i.relaxations, "drift"), 0);
      const gapMinutes = group.reduce((sum, i) => sum + sumRelaxation(i.relaxations, "gap"), 0);

      const s = weight * constants.SHRINK * unscheduled;
      const c = weight * constants.CHUNK * Math.max(0, group.length - 1);
      const d = weight * constants.DRIFT * driftMinutes;
      const g = weight * constants.GAP * gapMinutes;

      shrink += s;
      chunk += c;
      drift += d;
      gap += g;
      groupCost = s + c + d + g;
    }

    perInstance[primary.id] = groupCost;
    for (const inst of rest) perInstance[inst.id] = 0;
  }

  const idle = constants.IDLE * computeIdleMinutes(instances, lengthMinutes);
  const total = skip + shrink + chunk + drift + gap + idle;

  return { total, skip, shrink, chunk, drift, gap, idle, perInstance };
}

/**
 * Section 7.4's dominance invariant, cancelled of W(a): true when skipping
 * `activity` would NOT always cost strictly more than its worst legal
 * relaxation. `validateActivity` reports this as DOMINANCE_VIOLATION.
 */
export function violatesDominance(activity: Activity, constants: CostConstants): boolean {
  // SPEC-v2.md Section 8.3's restated invariant, identical arithmetic to
  // SPEC.md Section 7.4 under the new vocabulary: terms for absent rules are
  // zero.
  const elasticityRule = activity.rules.find((r): r is ElasticityRule => r.type === "elasticity");
  // SPEC-v2.1 §5.4: an activity may carry both a chunking RepeatRule
  // (sharedBudget: true) and a recurrence RepeatRule (sharedBudget: false)
  // at once — only the chunking one contributes a chunkTerm here.
  const repeatRule = activity.rules.find(
    (r): r is RepeatRule => r.type === "repeat" && r.sharedBudget,
  );
  const windowRules = activity.rules.filter((r): r is WindowRule => r.type === "window");
  const sequenceRule = activity.rules.find((r): r is SequenceRule => r.type === "sequence");

  const shrinkTerm = elasticityRule
    ? constants.SHRINK * (activity.durationMinutes - elasticityRule.minTotalMinutes)
    : 0;
  const chunkTerm =
    repeatRule && repeatRule.sharedBudget ? constants.CHUNK * (repeatRule.count - 1) : 0;
  const maxDriftMinutes =
    windowRules.length > 0 ? Math.max(...windowRules.map((w) => w.maxDriftMinutes)) : 0;
  const driftTerm = constants.DRIFT * maxDriftMinutes;
  const gapTerm = sequenceRule ? constants.GAP * sequenceRule.maxGapMinutes : 0;

  return constants.SKIP <= shrinkTerm + chunkTerm + driftTerm + gapTerm;
}
