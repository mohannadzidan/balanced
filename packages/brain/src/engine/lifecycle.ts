import type { TimelineActivity } from "./types";

export interface BackdatingOptions {
  /**
   * SPEC-v2.1 §3.3: blocks whose `plannedEnd` is more than this many minutes
   * before `now` become `SKIPPED` (with `skipReason: "LAPSED"`) instead of
   * `COMPLETED`. `undefined` preserves v1's "everything before `now` is
   * completed" behavior exactly.
   */
  readonly horizonMinutes?: number;
}

/**
 * SPEC.md Section 6.2 auto-transitions, applied by TICK (Section 9.2): a
 * PLANNED or ACTIVE instance whose planned span has been entirely passed by
 * `now` becomes COMPLETED (`completedSource: "backdated"`); a PLANNED
 * instance `now` currently sits inside becomes ACTIVE. COMPLETED, SKIPPED,
 * and CARRIED_IN instances are terminal and never revisited. `changed` is
 * false only when every instance's state is already consistent with `now` —
 * TICK's idempotency (calling twice with the same `now` is a no-op) depends
 * on this being exact.
 *
 * SPEC-v2.1 §3.3: when `horizonMinutes` is set, a block ending more than
 * `horizonMinutes` before `now` is recorded as `SKIPPED` (reason `LAPSED`)
 * instead of `COMPLETED`. The block's planned/actual times are cleared so
 * `cost.ts` doesn't charge completion for a block the user never actually
 * did. When `horizonMinutes` is `undefined` (the default), behavior is
 * identical to v1 — every block before `now` is backdated-completed.
 */
export function applyBackdating(
  instances: readonly TimelineActivity[],
  now: number,
  options: BackdatingOptions = {},
): { instances: TimelineActivity[]; changed: boolean } {
  const { horizonMinutes } = options;
  let changed = false;

  const next = instances.map((inst): TimelineActivity => {
    if (inst.state !== "PLANNED" && inst.state !== "ACTIVE") return inst;
    if (inst.plannedStart === null || inst.plannedEnd === null) return inst;

    if (inst.plannedEnd <= now) {
      changed = true;
      if (horizonMinutes !== undefined && inst.plannedEnd < now - horizonMinutes) {
        return {
          ...inst,
          state: "SKIPPED",
          skipReason: "LAPSED",
          plannedStart: null,
          plannedEnd: null,
          scheduledMinutes: 0,
          blockIndex: 1,
          blockCount: 1,
          chunkGroupId: null,
          hostInstanceId: null,
          relaxations: [],
          locked: true,
        };
      }
      return {
        ...inst,
        state: "COMPLETED",
        completedSource: "backdated",
        actualStart: inst.actualStart ?? inst.plannedStart,
        actualEnd: inst.plannedEnd,
      };
    }

    if (inst.state === "PLANNED" && inst.plannedStart <= now) {
      changed = true;
      return { ...inst, state: "ACTIVE", actualStart: inst.plannedStart };
    }

    return inst;
  });

  return { instances: next, changed };
}
