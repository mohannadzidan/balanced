import type { TimelineActivity } from "./types"

/**
 * SPEC.md Section 6.2 auto-transitions, applied by TICK (Section 9.2): a
 * PLANNED or ACTIVE instance whose planned span has been entirely passed by
 * `now` becomes COMPLETED (`completedSource: "backdated"`); a PLANNED
 * instance `now` currently sits inside becomes ACTIVE. COMPLETED, SKIPPED,
 * and CARRIED_IN instances are terminal and never revisited. `changed` is
 * false only when every instance's state is already consistent with `now` —
 * TICK's idempotency (calling twice with the same `now` is a no-op) depends
 * on this being exact.
 */
export function applyBackdating(
  instances: readonly TimelineActivity[],
  now: number
): { instances: TimelineActivity[]; changed: boolean } {
  let changed = false

  const next = instances.map((inst): TimelineActivity => {
    if (inst.state !== "PLANNED" && inst.state !== "ACTIVE") return inst
    if (inst.plannedStart === null || inst.plannedEnd === null) return inst

    if (inst.plannedEnd <= now) {
      changed = true
      return {
        ...inst,
        state: "COMPLETED",
        completedSource: "backdated",
        actualStart: inst.actualStart ?? inst.plannedStart,
        actualEnd: inst.plannedEnd,
      }
    }

    if (inst.state === "PLANNED" && inst.plannedStart <= now) {
      changed = true
      return { ...inst, state: "ACTIVE", actualStart: inst.plannedStart }
    }

    return inst
  })

  return { instances: next, changed }
}
