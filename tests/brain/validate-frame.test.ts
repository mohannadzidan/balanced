// Tests for validateFrame (SPEC-v2.1 §3 / §13.2).
// Pure pre-flight check on the Frame shape; not auto-run by solve().

import { describe, expect, it } from "vitest"
import { validateFrame } from "@/app/brain/engine/validation"
import { resolveDayFrame, resolveFrame } from "@/app/brain/engine/time"

describe("validateFrame (SPEC-v2.1 §3 / §13.2)", () => {
	it("returns no issues for a 1-day frame", () => {
		const frame = resolveDayFrame("2026-07-29", "UTC")
		expect(validateFrame(frame)).toEqual([])
	})

	it("returns no issues for a 7-day frame", () => {
		const frame = resolveFrame("2026-07-29", 7, "UTC")
		expect(validateFrame(frame)).toEqual([])
	})

	it("returns no issues for a frame at exactly the cap (366 days)", () => {
		const frame = resolveFrame("2026-07-29", 366, "UTC")
		expect(validateFrame(frame)).toEqual([])
	})

	it("flags FRAME_TOO_LONG for dayCount > 366", () => {
		const frame = resolveFrame("2026-07-29", 367, "UTC")
		const issues = validateFrame(frame)
		expect(issues).toHaveLength(1)
		expect(issues[0].code).toBe("FRAME_TOO_LONG")
		expect(issues[0].severity).toBe("error")
		expect(issues[0].activityId).toBeNull()
	})

	it("flags FRAME_DEFAULT_WINDOW_INVALID for a malformed defaultDayWindow", () => {
		const frame = {
			...resolveFrame("2026-07-29", 7, "UTC"),
			defaultDayWindow: { startWall: "25:99", endWall: "23:00" },
		}
		const issues = validateFrame(frame)
		expect(issues.map((i) => i.code)).toContain("FRAME_DEFAULT_WINDOW_INVALID")
	})

	it("accepts a valid defaultDayWindow", () => {
		const frame = {
			...resolveFrame("2026-07-29", 7, "UTC"),
			defaultDayWindow: { startWall: "07:00", endWall: "23:00" },
		}
		expect(validateFrame(frame)).toEqual([])
	})

	it("flags FRAME_BACKDATE_HORIZON_INVALID for a negative horizon", () => {
		const frame = {
			...resolveFrame("2026-07-29", 7, "UTC"),
			backdateHorizonMinutes: -1,
		}
		const issues = validateFrame(frame)
		expect(issues.map((i) => i.code)).toContain("FRAME_BACKDATE_HORIZON_INVALID")
	})

	it("accepts a zero backdateHorizonMinutes (no backdating past `now` at all)", () => {
		const frame = {
			...resolveFrame("2026-07-29", 7, "UTC"),
			backdateHorizonMinutes: 0,
		}
		expect(validateFrame(frame)).toEqual([])
	})
})