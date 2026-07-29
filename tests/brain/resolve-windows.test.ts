// Tests for resolveWindows (SPEC-v2.1 §4).
// Pure per-day window expansion; not yet wired into solve().

import { describe, expect, it } from "vitest"
import { resolveWindows } from "@/app/brain/engine/resolve"
import { resolveFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

describe("resolveWindows (SPEC-v2.1 §4)", () => {
	it("expands per-weekday windows: Mon/Wed/Fri across 7 days yields 3 windows", () => {
		const frame = resolveFrame("2026-07-27", 7, "UTC") // Mon..Sun
		const gym = activity("Gym")
			.rank(1)
			.minutes(60)
			.window("18:00", "20:00", { drift: 15, days: ["MON", "WED", "FRI"] })
			.build()
		const windows = resolveWindows(gym, frame)
		// Should be exactly 3: Mon (day 0), Wed (day 2), Fri (day 4).
		expect(windows).toHaveLength(3)
		const dayIndexes = windows.map((w) => w.dayIndex).sort()
		expect(dayIndexes).toEqual([0, 2, 4])
	})

	it("spanning strict window (sleep 23:00–07:00) resolves to one contiguous interval crossing a day boundary", () => {
		// Build a 3-day frame and a Sleep activity with a single strict window
		// whose end < start. The first day gets one window spanning across
		// the day boundary into the next day.
		const frame = resolveFrame("2026-07-27", 3, "UTC") // Mon, Tue, Wed
		const sleep = activity("Sleep")
			.rank(1)
			.minutes(480)
			.window("23:00", "07:00", { drift: 0, days: ["MON", "TUE", "WED"] })
			.build()
		const windows = resolveWindows(sleep, frame)
		// One window per eligible day: day 0 (Mon), day 1 (Tue), day 2 (Wed).
		// Each spans into the next day (or past frame end on the last day).
		expect(windows).toHaveLength(3)
		// Day 0 window: 23:00 = 1380 minutes on day 0 + 7:00 = 420 minutes on day 1.
		// So [1380, 1440+420) = [1380, 1860).
		expect(windows[0].dayIndex).toBe(0)
		expect(windows[0].start).toBe(23 * 60) // 1380
		expect(windows[0].end).toBe(1440 + 7 * 60) // 1860
		// Day 1 window: 23:00 on day 1 (= 1440+1380=2820) until 7:00 on day 2 (= 2880+420=3300).
		expect(windows[1].dayIndex).toBe(1)
		expect(windows[1].start).toBe(1440 + 23 * 60)
		expect(windows[1].end).toBe(2880 + 7 * 60)
	})

	it("returns empty array for an activity with no WindowRule when no eligible days match", () => {
		// Per Drop 1 semantics, an activity with no WindowRule is unconstrained.
		// But under SPEC-v2.1 §4, the eligibility is the union of windows'
		// day sets; with no windows at all, behavior is to produce no occurrences.
		const frame = resolveFrame("2026-07-27", 7, "UTC")
		const adHoc = activity("AdHoc").rank(1).minutes(30).build()
		const windows = resolveWindows(adHoc, frame)
		// No window rules → empty resolution (matches Drop 1 semantics where
		// the activity would be "unconstrained", but at the windows layer it
		// simply has no resolved intervals).
		expect(windows).toEqual([])
	})
})