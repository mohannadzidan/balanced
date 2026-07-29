// fast-check arbitraries for brain engine property-based tests.
// SPEC.md §16.1 layer 5, extended by SPEC-v2.1 §15.1 criterion 3 over N-day frames.
//
// These arbitraries produce grammars that comply with Drop 1 validation rules
// (period: "day", count: 1, sharedBudget: true, minSeparationMinutes: 0,
// requiredCount: 0 or 1) so they exercise the current pipeline. Wider grammar
// (Drop 2 features) lands incrementally as each step unlocks the fields.

import * as fc from "fast-check"
import type { Activity, Weekday, WindowRule, ElasticityRule, FixedRule } from "@/app/brain/engine/types"

const ALL_WEEKDAYS: readonly Weekday[] = [
	"SUN",
	"MON",
	"TUE",
	"WED",
	"THU",
	"FRI",
	"SAT",
]

// Helper: a wall-clock string on the 5-minute grid, anchored to start ≤ 23:55.
function wallArb(): fc.Arbitrary<string> {
	return fc
		.integer({ min: 0, max: 23 * 60 + 55 })
		.filter((m) => m % 5 === 0)
		.map((m) => {
			const h = Math.floor(m / 60)
			const mm = m % 60
			return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`
		})
}

// A weekday subset (non-empty, since an empty set means no eligibility at all).
export const weekdaySubsetArb: fc.Arbitrary<readonly Weekday[]> = fc
	.subarray([...ALL_WEEKDAYS], { minLength: 1 })
	.map((arr) => arr as readonly Weekday[])

// A WindowRule with a window and a non-empty day subset.
export const windowRuleArb: fc.Arbitrary<WindowRule> = fc
	.tuple(
		wallArb(),
		wallArb(),
		fc.integer({ min: 0, max: 120 }),
		weekdaySubsetArb,
	)
	.filter(([start, end, drift, days]) => {
		// Strict windows (drift = 0) must have end > start for them to be non-trivial.
		if (drift === 0 && start >= end) return false
		return days.length > 0
	})
	.map(
		([start, end, drift, days]): WindowRule => ({
			type: "window",
			source: "template",
			days: days as readonly Weekday[],
			startWall: start,
			endWall: end,
			maxDriftMinutes: drift,
		}),
	)

// An ElasticityRule with a sane floor (multiple of GRID, ≤ activity duration).
export const elasticityRuleArb = (maxDuration: number): fc.Arbitrary<ElasticityRule> =>
	fc
		.integer({ min: 5, max: maxDuration })
		.filter((m) => m % 5 === 0)
		.map((floor): ElasticityRule => ({
			type: "elasticity",
			source: "template",
			minTotalMinutes: floor,
			minBlockMinutes: floor,
		}))

// A FixedRule at a wall-clock range.
export const fixedRuleArb: fc.Arbitrary<FixedRule> = fc
	.tuple(wallArb(), wallArb())
	.map(
		([start, end]): FixedRule => ({
			type: "fixed",
			source: "template",
			startWall: start,
			endWall: end,
		}),
	)

// An Activity — the simplest Drop-1-compatible template:
//   rank ∈ [1..10], duration on the 5-min grid, no rules, no requiredCount.
export const simpleActivityArb: fc.Arbitrary<Activity> = fc
	.tuple(
		fc.string({ minLength: 1, maxLength: 12 }),
		fc.integer({ min: 5, max: 180 }).filter((m) => m % 5 === 0),
		fc.integer({ min: 1, max: 10 }),
	)
	.map(([name, minutes, rank]): Activity => ({
		id: name,
		name,
		durationMinutes: minutes,
		priorityRank: rank,
		enabled: true,
		rules: [],
		requiredCount: 0,
	}))

// An Activity with a single WindowRule (no fixed, no repeat, no sequence).
export const windowedActivityArb: fc.Arbitrary<Activity> = fc
	.tuple(
		fc.string({ minLength: 1, maxLength: 12 }),
		fc.integer({ min: 5, max: 180 }).filter((m) => m % 5 === 0),
		fc.integer({ min: 1, max: 10 }),
		windowRuleArb,
	)
	.map(
		([name, minutes, rank, rule]): Activity => ({
			id: name,
			name,
			durationMinutes: minutes,
			priorityRank: rank,
			enabled: true,
			rules: [rule],
			requiredCount: 0,
		}),
	)

// A small catalogue (1-5 activities) of either simple or windowed activities.
export const catalogArb: fc.Arbitrary<readonly Activity[]> = fc
	.array(fc.oneof(simpleActivityArb, windowedActivityArb), {
		minLength: 1,
		maxLength: 5,
	})
	.map((activities): readonly Activity[] => {
		// De-duplicate priority ranks (priority must be unique).
		const seen = new Set<number>()
		return activities.map((a, i) => {
			let rank = a.priorityRank
			while (seen.has(rank)) rank++
			seen.add(rank)
			return { ...a, id: `${a.id}-${i}`, priorityRank: rank }
		})
	})

// Helper: a date (ISO YYYY-MM-DD) for resolveDayFrame.
export const dateArb: fc.Arbitrary<string> = fc
	.integer({ min: 2020, max: 2030 })
	.chain((year) =>
		fc.integer({ min: 1, max: 12 }).chain((month) =>
			fc.integer({ min: 1, max: 28 }).map((day) => {
				const m = String(month).padStart(2, "0")
				const d = String(day).padStart(2, "0")
				return `${year}-${m}-${d}`
			}),
		),
	)
