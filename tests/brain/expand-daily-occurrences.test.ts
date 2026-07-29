// Tests for expandDailyOccurrences (SPEC-v2.1 §15 row 2's restricted scope).
// Pure per-day catalog expansion; not yet wired into solve().

import { describe, expect, it } from "vitest"
import { expandDailyOccurrences } from "@/app/brain/engine/resolve"
import { resolveFrame } from "@/app/brain/engine/time"
import { activity } from "./support/fixtures"

describe("expandDailyOccurrences (SPEC-v2.1 §15 row 2)", () => {
	it("expands a plain unwindowed activity into one ghost per day of the frame", () => {
		const frame = resolveFrame("2026-07-27", 3, "UTC") // Mon, Tue, Wed
		const gym = activity("Gym").rank(1).minutes(60).build()
		const occurrences = expandDailyOccurrences([gym], frame)
		expect(occurrences).toHaveLength(3)
		expect(occurrences.map((o) => o.sourceId)).toEqual(["gym", "gym", "gym"])
		expect(occurrences.map((o) => o.day.index)).toEqual([0, 1, 2])
		expect(occurrences.map((o) => o.ghost.id)).toEqual([
			"gym@2026-07-27",
			"gym@2026-07-28",
			"gym@2026-07-29",
		])
	})

	it("only expands into days matching the activity's window days", () => {
		const frame = resolveFrame("2026-07-27", 7, "UTC") // Mon..Sun
		const gym = activity("Gym")
			.rank(1)
			.minutes(60)
			.window("18:00", "20:00", { drift: 15, days: ["MON", "WED", "FRI"] })
			.build()
		const occurrences = expandDailyOccurrences([gym], frame)
		expect(occurrences.map((o) => o.day.index)).toEqual([0, 2, 4])
	})

	it("passes a FixedRule activity through unchanged, using frame.days[0]", () => {
		const frame = resolveFrame("2026-07-27", 5, "UTC")
		const standup = activity("Standup").rank(1).minutes(15).fixed("09:00", "09:15").build()
		const occurrences = expandDailyOccurrences([standup], frame)
		expect(occurrences).toHaveLength(1)
		expect(occurrences[0].ghost).toBe(standup) // same reference, not a ghost
		expect(occurrences[0].sourceId).toBe("standup")
		expect(occurrences[0].day.index).toBe(0)
	})

	it("passes an OverlapRule host and its referenced guest through unchanged", () => {
		const frame = resolveFrame("2026-07-27", 5, "UTC")
		const work = activity("Work")
			.rank(1)
			.minutes(480)
			.overlap({ budget: 30, guests: ["email"] })
			.build()
		const email = activity("Email").rank(2).minutes(15).build()
		const occurrences = expandDailyOccurrences([work, email], frame)
		expect(occurrences).toHaveLength(2)
		expect(occurrences.every((o) => o.day.index === 0)).toBe(true)
		expect(occurrences.map((o) => o.ghost.id).sort()).toEqual(["email", "work"])
	})

	it("passes a SequenceRule dependent and its linked host through unchanged", () => {
		const frame = resolveFrame("2026-07-27", 5, "UTC")
		const work = activity("Work").rank(1).minutes(480).build()
		const commute = activity("Commute")
			.rank(2)
			.minutes(30)
			.sequence("post", "work", { maxGap: 15 })
			.build()
		const occurrences = expandDailyOccurrences([work, commute], frame)
		expect(occurrences).toHaveLength(2)
		expect(occurrences.every((o) => o.day.index === 0)).toBe(true)
	})

	it("at dayCount=1, a ghostable activity still gets a day-scoped id", () => {
		const frame = resolveFrame("2026-07-27", 1, "UTC")
		const gym = activity("Gym").rank(1).minutes(60).build()
		const occurrences = expandDailyOccurrences([gym], frame)
		expect(occurrences).toHaveLength(1)
		expect(occurrences[0].ghost.id).toBe("gym@2026-07-27")
		expect(occurrences[0].sourceId).toBe("gym")
	})
})
