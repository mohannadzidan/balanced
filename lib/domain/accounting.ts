/**
 * Overlap-aware time accounting (FR-026, data-model.md "Time accounting").
 *
 * Three distinct quantities are computed here and deliberately never
 * conflated: an activity's own progress, a host's own logged duration, and
 * the day's union-measured total. Keep this module small — Constitution V
 * (YAGNI) rules out a generic aggregation layer; new figures are plain
 * functions appended below.
 *
 * These functions never touch the database or the browser, matching
 * `lib/domain/rules.ts`'s purity so both are directly unit-testable.
 */

import { durationMin } from "@/lib/time"
import type { ScheduledBlock } from "@/lib/domain/types"

/**
 * An activity's own progress for the date: the sum of its `scheduled_block`
 * durations, regardless of whether each block is standalone or a guest block
 * over some host (`hostActivityId` is irrelevant here — a block always counts
 * toward *its own* `activityId`'s progress). Over-target totals are returned
 * as-is; there is no cap this feature (spec Edge Case).
 */
export function activityProgressMin(
  activityId: string,
  blocks: ScheduledBlock[]
): number {
  return blocks
    .filter((block) => block.activityId === activityId)
    .reduce(
      (total, block) => total + durationMin(block.startMin, block.endMin),
      0
    )
}
