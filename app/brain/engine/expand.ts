import { resolveWindows, windowRulesOf } from "./resolve"
import { isoWeekKey } from "./time"
import type {
  Activity,
  BucketSpan,
  Frame,
  Occurrence,
  RepeatQuotas,
  RepeatRule,
  ResolvedWindow,
} from "./types"

/**
 * SPEC-v2.1 §5.4: RepeatRule is one operation applied at two independent
 * levels — `sharedBudget: false` (recurrence: this function's job, Activity
 * -> Occurrences) and `sharedBudget: true` (chunking: Drop 1's existing
 * per-occurrence shrink/chunk machinery, Occurrence -> Blocks). An activity
 * may legally carry one of each simultaneously ("Gym three times a week,
 * each session splittable into two"); only the recurrence rule bears on
 * bucketing here. The chunking rule, if present, stays on `activity.rules`
 * untouched and is picked up downstream exactly as it is today.
 */
function recurrenceRuleOf(activity: Activity): RepeatRule | null {
  return (
    activity.rules.find(
      (r): r is RepeatRule => r.type === "repeat" && !r.sharedBudget
    ) ?? null
  )
}

/**
 * SPEC-v2.1 §5.1: `RepeatRule.period` partitions the frame into buckets,
 * clipped to the frame. `"day"` and `"frame"` read straight off `frame.days`
 * / `frame.lengthMinutes`; `"week"`/`"month"` group consecutive frame days
 * sharing an ISO-week or calendar-month key, so a bucket's span is exactly
 * the union of its member days — already clipped to the frame because it's
 * built only from days the frame actually contains.
 */
function bucketsForPeriod(
  period: RepeatRule["period"],
  frame: Frame
): readonly BucketSpan[] {
  if (period === "frame") {
    return [{ key: "frame", start: 0, end: frame.lengthMinutes }]
  }
  if (period === "day") {
    return frame.days.map((day) => ({
      key: day.date,
      start: day.startOffset,
      end: day.startOffset + day.lengthMinutes,
      dayIndex: day.index,
    }))
  }

  const keyOf = period === "week" ? isoWeekKey : (date: string) => date.slice(0, 7)
  const spans = new Map<string, { start: number; end: number }>()
  for (const day of frame.days) {
    const key = keyOf(day.date)
    const end = day.startOffset + day.lengthMinutes
    const existing = spans.get(key)
    if (existing) {
      existing.end = end // frame.days is chronological, so end only grows
    } else {
      spans.set(key, { start: day.startOffset, end })
    }
  }
  // §5.1: "bucketKey sorts lexicographically in [chronological] order" — true
  // for "YYYY-MM" and "YYYY-Www" keys, so this also fixes iteration order.
  return [...spans.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, span]) => ({ key, ...span }))
}

/** Selects `windows` for one bucket. A `period: "day"` bucket selects by
 * `dayIndex` — the day a window originates from — not by span overlap: a
 * midnight-spanning window's `end` legitimately extends into the next day,
 * and clipping-by-overlap would hand that same window to both days' buckets,
 * producing a phantom second occurrence for one recurrence. A `week`/`month`/
 * `frame` bucket aggregates several days into one, so it clips by span
 * instead — a window entirely outside the bucket disappears rather than
 * clamping to an empty/negative range. */
function windowsInBucket(
  windows: readonly ResolvedWindow[],
  bucket: BucketSpan
): readonly ResolvedWindow[] {
  if (bucket.dayIndex !== undefined) {
    return windows.filter((w) => w.dayIndex === bucket.dayIndex)
  }
  const clipped: ResolvedWindow[] = []
  for (const w of windows) {
    const start = Math.max(w.start, bucket.start)
    const end = Math.min(w.end, bucket.end)
    if (start < end) {
      clipped.push({ ...w, start, end })
    }
  }
  return clipped
}

/**
 * SPEC-v2.1 §5: the solver's new unit of work. Pure, additive, and — until
 * wired into `runPipeline` (§15 row 3, a later slice) — unused by `solve()`.
 *
 * For each bucket and each `1..(count - quotaPlaced)`, emits an occurrence
 * whose `windows` are the activity's resolved windows intersected with that
 * bucket. A bucket with no eligible windows yields no occurrences — day
 * eligibility and recurrence compose with no special case (§5.2).
 *
 * An activity without a recurrence RepeatRule (`sharedBudget: false`) is
 * treated as `period: "day", count: 1` (see `recurrenceRuleOf`'s docstring
 * for why "day" and not "frame").
 */
export function expand(
  catalog: readonly Activity[],
  frame: Frame,
  quotas: RepeatQuotas = { placed: new Map() }
): Occurrence[] {
  const occurrences: Occurrence[] = []

  for (const activity of catalog) {
    const repeat = recurrenceRuleOf(activity)
    // SPEC-v2.1 §2's own equivalence property (already the §15 row 2 hard
    // gate) fixes this default: an activity with no RepeatRule must produce
    // one occurrence per eligible day across a multi-day frame — matching N
    // chained 1-day solves — not one occurrence for the whole frame. At
    // dayCount=1 "day" and "frame" buckets coincide, so this is also exactly
    // Drop 1's one-instance-per-solve behavior.
    const period = repeat?.period ?? "day"
    const count = repeat?.count ?? 1

    // An activity with no WindowRule at all is unconstrained (§3.2: "implicit
    // window covering every day in full"), not ineligible everywhere — the
    // same contract `evaluateCandidate` already gives `windows.length === 0`
    // (always feasible). Bucket-intersecting an empty window list would
    // otherwise silently produce zero occurrences for it in every bucket.
    const unconstrained = windowRulesOf(activity).length === 0
    const windows = resolveWindows(activity, frame)
    const buckets = bucketsForPeriod(period, frame)

    for (const bucket of buckets) {
      const bucketWindows = unconstrained ? [] : windowsInBucket(windows, bucket)
      if (!unconstrained && bucketWindows.length === 0) continue

      const placed = quotas.placed.get(activity.id)?.get(bucket.key) ?? 0
      const toEmit = Math.max(0, count - placed)
      const bucketOccurrenceIds = Array.from(
        { length: toEmit },
        (_, i) => `${activity.id}@${bucket.key}#${i + 1}`
      )

      for (let index = 1; index <= toEmit; index++) {
        const id = bucketOccurrenceIds[index - 1]
        occurrences.push({
          id,
          activity,
          bucketKey: bucket.key,
          index,
          windows: bucketWindows,
          required: index <= activity.requiredCount,
          siblingIds: bucketOccurrenceIds.filter((sid) => sid !== id),
        })
      }
    }
  }

  // §5.3: sorted by (activity.priorityRank, bucketKey, index); bucket
  // enumeration above is already chronological, so this only needs to
  // resolve ties across activities and re-assert bucket/index order.
  return occurrences.sort((a, b) => {
    if (a.activity.priorityRank !== b.activity.priorityRank) {
      return a.activity.priorityRank - b.activity.priorityRank
    }
    if (a.bucketKey !== b.bucketKey) return a.bucketKey.localeCompare(b.bucketKey)
    return a.index - b.index
  })
}
