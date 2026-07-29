// Tests for computeTailroom (SPEC-v2.1 §4.1).
// tailroom = max(0, max over windows of (w.end − lengthMinutes)).

import { describe, expect, it } from "vitest"
import { computeTailroom } from "@/app/brain/engine/constants"
import type { ResolvedWindow } from "@/app/brain/engine/resolve"

describe("computeTailroom (SPEC-v2.1 §4.1)", () => {
	it("returns 0 when no window extends past lengthMinutes", () => {
		const windows: ResolvedWindow[] = [
			{ start: 0, end: 60, maxDriftMinutes: 0, dayIndex: 0 },
			{ start: 100, end: 200, maxDriftMinutes: 0, dayIndex: 0 },
		]
		expect(computeTailroom(windows, 1440)).toBe(0)
	})

	it("returns w.end − lengthMinutes when a window extends past lengthMinutes", () => {
		const windows: ResolvedWindow[] = [
			{ start: 1380, end: 1860, maxDriftMinutes: 0, dayIndex: 0 },
		]
		// 1860 − 1440 = 420.
		expect(computeTailroom(windows, 1440)).toBe(420)
	})

	it("returns the maximum excess across multiple windows", () => {
		const windows: ResolvedWindow[] = [
			{ start: 1380, end: 1500, maxDriftMinutes: 0, dayIndex: 0 }, // excess 60
			{ start: 1000, end: 1700, maxDriftMinutes: 0, dayIndex: 0 }, // excess 260
			{ start: 1380, end: 1860, maxDriftMinutes: 0, dayIndex: 0 }, // excess 420 (max)
		]
		expect(computeTailroom(windows, 1440)).toBe(420)
	})

	it("returns 0 for an empty window list", () => {
		expect(computeTailroom([], 1440)).toBe(0)
	})

	it("ignores windows that end exactly at lengthMinutes", () => {
		const windows: ResolvedWindow[] = [
			{ start: 0, end: 1440, maxDriftMinutes: 0, dayIndex: 0 },
		]
		expect(computeTailroom(windows, 1440)).toBe(0)
	})
})