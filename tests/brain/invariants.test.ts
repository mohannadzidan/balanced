// Unit tests for checkInvariants (SPEC.md §4.5 / §16.1 layer 4).
// Each test constructs a hand-built Timeline fixture that violates exactly one invariant.

import { describe, it, expect } from "vitest"
import { checkInvariants } from "@/app/brain/engine/invariants"
import type { Timeline, TimelineActivity, DayFrame, CostBreakdown } from "@/app/brain/engine/types"

function makeDayFrame(overrides: Partial<DayFrame> = {}): DayFrame {
	const now = new Date()
	const date = now.toISOString().split("T")[0]
	return {
		date,
		startDate: date,
		timezone: "UTC",
		startInstant: now.getTime(),
		dayCount: 1,
		lengthMinutes: 1440,
		days: [
			{
				index: 0,
				date,
				weekday: "MON",
				startOffset: 0,
				lengthMinutes: 1440,
			},
		],
		...overrides,
	}
}

function makeCostBreakdown(): CostBreakdown {
	return {
		total: 0,
		skip: 0,
		shrink: 0,
		chunk: 0,
		drift: 0,
		gap: 0,
		idle: 0,
		perInstance: {},
	}
}

function makeBaseTimeline(instances: TimelineActivity[] = []): Timeline {
	return {
		dayFrame: makeDayFrame(),
		revision: 1,
		instances,
		diagnostics: [],
		cost: makeCostBreakdown(),
		status: "OK",
		solvedAtOffset: 540, // 09:00
		finalised: false,
		carryIn: [],
	}
}

function makeInstance(overrides: Partial<TimelineActivity> = {}): TimelineActivity {
	return {
		id: "inst-1",
		activityId: "act-1",
		date: "2026-01-05",
		name: "Test",
		durationMinutes: 60,
		priorityRank: 1,
		requiredCount: 0,
		rules: [],
		state: "PLANNED",
		completedSource: null,
		plannedStart: 540,
		plannedEnd: 600,
		actualStart: null,
		actualEnd: null,
		scheduledMinutes: 60,
		occurrenceId: "act-1@2026-01-05#1",
		occurrenceIndex: 1,
		bucketKey: "2026-01-05",
		blockIndex: 1,
		blockCount: 1,
		chunkGroupId: null,
		hostInstanceId: null,
		isAdhoc: false,
		spanningFromPreviousDay: false,
		relaxations: [],
		locked: false,
		skipReason: null,
		...overrides,
	}
}

describe("checkInvariants — SPEC.md §4.5 invariants", () => {
	it("Invariant 1: catches overlapping top-level instances", () => {
		const a = makeInstance({ id: "a", name: "A", plannedStart: 540, plannedEnd: 600 })
		const b = makeInstance({ id: "b", name: "B", plannedStart: 570, plannedEnd: 630 }) // overlaps A
		const timeline = makeBaseTimeline([a, b])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_1_NO_TOP_LEVEL_OVERLAP")).toBe(true)
	})

	it("Invariant 2: catches guest outside host", () => {
		const host = makeInstance({ id: "host", name: "Host", plannedStart: 540, plannedEnd: 660 })
		const guest = makeInstance({
			id: "guest",
			name: "Guest",
			hostInstanceId: "host",
			plannedStart: 500, // before host
			plannedEnd: 600,
		})
		const timeline = makeBaseTimeline([host, guest])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_2_GUEST_INSIDE_HOST")).toBe(true)
	})

	it("Invariant 3: catches overlapping guests of same host", () => {
		const host = makeInstance({ id: "host", name: "Host", plannedStart: 540, plannedEnd: 720 })
		const g1 = makeInstance({ id: "g1", name: "G1", hostInstanceId: "host", plannedStart: 540, plannedEnd: 600 })
		const g2 = makeInstance({ id: "g2", name: "G2", hostInstanceId: "host", plannedStart: 570, plannedEnd: 630 })
		const timeline = makeBaseTimeline([host, g1, g2])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_3_GUESTS_NON_OVERLAPPING")).toBe(true)
	})

	it("Invariant 4: catches guest intersecting host exclusion window", () => {
		const host = makeInstance({
			id: "host",
			name: "Host",
			plannedStart: 540,
			plannedEnd: 720,
			rules: [
				{
					type: "overlap",
					source: "template",
					budgetMinutes: 120,
					allowedGuestIds: ["guest"],
					exclusionWindows: [
						{
							id: "ex-1",
							name: "Exclusion",
							anchor: "relative" as const,
							startOffset: 30,
							endOffset: 60,
						},
					],
				},
			],
		})
		const guest = makeInstance({
			id: "guest",
			name: "Guest",
			hostInstanceId: "host",
			plannedStart: 560, // inside exclusion [570, 600)
			plannedEnd: 600,
		})
		const timeline = makeBaseTimeline([host, guest])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_4_GUEST_AVOIDS_EXCLUSION")).toBe(true)
	})

	it("Invariant 5: catches guest budget exceeding host overlap budget", () => {
		const host = makeInstance({
			id: "host",
			name: "Host",
			plannedStart: 540,
			plannedEnd: 720,
			rules: [
				{
					type: "overlap",
					source: "template",
					budgetMinutes: 60,
					allowedGuestIds: ["g1", "g2"],
					exclusionWindows: [],
				},
			],
		})
		const g1 = makeInstance({ id: "g1", name: "G1", hostInstanceId: "host", scheduledMinutes: 40 })
		const g2 = makeInstance({ id: "g2", name: "G2", hostInstanceId: "host", scheduledMinutes: 40 }) // total 80 > 60
		const timeline = makeBaseTimeline([host, g1, g2])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_5_GUEST_BUDGET")).toBe(true)
	})

	it("Invariant 6: catches scheduled > duration", () => {
		const inst = makeInstance({
			id: "i",
			name: "I",
			durationMinutes: 60,
			scheduledMinutes: 70,
			relaxations: [{ type: "shrink", minutes: 10 }],
		})
		const timeline = makeBaseTimeline([inst])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_6_SCHEDULED_WITHIN_BOUNDS")).toBe(true)
	})

	it("Invariant 6: catches scheduled below per-chunk floor when > 0", () => {
		const inst = makeInstance({
			id: "i",
			name: "I",
			durationMinutes: 60,
			scheduledMinutes: 30,
			rules: [
				{
					type: "elasticity",
					source: "template",
					minTotalMinutes: 45,
					minBlockMinutes: 45,
				},
			],
		})
		const timeline = makeBaseTimeline([inst])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_6_SCHEDULED_WITHIN_BOUNDS")).toBe(true)
	})

	it("Invariant 7: catches off-grid plannedStart", () => {
		const inst = makeInstance({ id: "i", name: "I", plannedStart: 542 }) // not multiple of 5
		const timeline = makeBaseTimeline([inst])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_7_GRID_ALIGNMENT")).toBe(true)
	})

	it("Invariant 7: catches off-grid plannedEnd", () => {
		const inst = makeInstance({ id: "i", name: "I", plannedEnd: 603 }) // not multiple of 5
		const timeline = makeBaseTimeline([inst])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_7_GRID_ALIGNMENT")).toBe(true)
	})

	it("Invariant 8: catches instance starting before freeze boundary", () => {
		const anchor = makeInstance({ id: "anchor", name: "Anchor", state: "COMPLETED", actualEnd: 540, plannedEnd: 540, plannedStart: 480, scheduledMinutes: 60 })
		const inst = makeInstance({ id: "i", name: "I", plannedStart: 500, locked: false }) // before freeze boundary 540
		const timeline = makeBaseTimeline([anchor, inst])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_8_NO_START_BEFORE_FROZEN")).toBe(true)
	})

	it("Invariant 8: allows locked instance before freeze boundary", () => {
		const inst = makeInstance({ id: "i", name: "I", plannedStart: 500, locked: true })
		const timeline = makeBaseTimeline([inst])
		const violations = checkInvariants(timeline)
		expect(violations.some((v) => v.code === "INVARIANT_8_NO_START_BEFORE_FROZEN")).toBe(false)
	})

	it("clean timeline: no violations", () => {
		const a = makeInstance({ id: "a", name: "A", plannedStart: 540, plannedEnd: 600 })
		const b = makeInstance({ id: "b", name: "B", plannedStart: 600, plannedEnd: 660 })
		const timeline = makeBaseTimeline([a, b])
		const violations = checkInvariants(timeline)
		expect(violations).toHaveLength(0)
	})
})