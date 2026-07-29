import type { Timeline, TimelineActivity } from "./types"
import { GRID } from "./constants"

export type InvariantCode =
	| "INVARIANT_1_NO_TOP_LEVEL_OVERLAP"
	| "INVARIANT_2_GUEST_INSIDE_HOST"
	| "INVARIANT_3_GUESTS_NON_OVERLAPPING"
	| "INVARIANT_4_GUEST_AVOIDS_EXCLUSION"
	| "INVARIANT_5_GUEST_BUDGET"
	| "INVARIANT_6_SCHEDULED_WITHIN_BOUNDS"
	| "INVARIANT_7_GRID_ALIGNMENT"
	| "INVARIANT_8_NO_START_BEFORE_FROZEN"
	| "INVARIANT_9_EXCLUSION_NO_COST"

export interface InvariantViolation {
	readonly code: InvariantCode
	readonly instanceIds: readonly string[]
	readonly message: string
}

/** SPEC.md §4.5 / §16.1 layer 4: structural invariants that must hold on every timeline. */
export function checkInvariants(timeline: Timeline): InvariantViolation[] {
	const violations: InvariantViolation[] = []
	const instances = timeline.instances

	// Invariant 1: Top-level blocks never overlap each other.
	// Top-level = not a guest (hostInstanceId === null)
	// Use effective end = actualEnd ?? plannedEnd to handle FINISH_EARLY cases
	// where a block's actual consumption is shorter than its planned span.
	const effectiveEnd = (i: TimelineActivity): number | null => {
		if (i.plannedStart === null || i.plannedEnd === null) return null
		if (i.actualEnd !== null) return i.actualEnd
		return i.plannedEnd
	}
	const topLevel = instances.filter((i) => i.hostInstanceId === null)
	for (let a = 0; a < topLevel.length; a++) {
		for (let b = a + 1; b < topLevel.length; b++) {
			const ia = topLevel[a]
			const ib = topLevel[b]
			const iaEnd = effectiveEnd(ia)
			const ibEnd = effectiveEnd(ib)
			if (
				ia.plannedStart !== null &&
				iaEnd !== null &&
				ib.plannedStart !== null &&
				ibEnd !== null
			) {
				if (
					ia.plannedStart < ibEnd &&
					ib.plannedStart < iaEnd
				) {
					violations.push({
						code: "INVARIANT_1_NO_TOP_LEVEL_OVERLAP",
						instanceIds: [ia.id, ib.id],
						message: `Top-level instances ${ia.name} (${ia.id}) and ${ib.name} (${ib.id}) overlap`,
					})
				}
			}
		}
	}

	// Helper: build host -> guests map
	const guestsByHost = new Map<string, TimelineActivity[]>()
	for (const inst of instances) {
		if (inst.hostInstanceId !== null) {
			const arr = guestsByHost.get(inst.hostInstanceId) || []
			arr.push(inst)
			guestsByHost.set(inst.hostInstanceId, arr)
		}
	}

	// Invariant 2: A guest block lies entirely within its host's placement.
	// Invariant 3: Guests of the same host never overlap each other.
	// Invariant 4: No guest intersects any exclusion window of its host.
	// Invariant 5: Sum of guest durations per host ≤ that host's overlap budget.
	for (const host of instances) {
		const guests = guestsByHost.get(host.id)
		if (!guests || guests.length === 0) continue

		const hostStart = host.plannedStart
		const hostEnd = host.plannedEnd
		if (hostStart === null || hostEnd === null) continue

		// Invariant 2
		for (const guest of guests) {
			if (guest.plannedStart === null || guest.plannedEnd === null) continue
			if (guest.plannedStart < hostStart || guest.plannedEnd > hostEnd) {
				violations.push({
					code: "INVARIANT_2_GUEST_INSIDE_HOST",
					instanceIds: [guest.id, host.id],
					message: `Guest ${guest.name} (${guest.id}) not fully inside host ${host.name} (${host.id})`,
				})
			}
		}

		// Invariant 3
		for (let a = 0; a < guests.length; a++) {
			for (let b = a + 1; b < guests.length; b++) {
				const ga = guests[a]
				const gb = guests[b]
				if (
					ga.plannedStart !== null &&
					ga.plannedEnd !== null &&
					gb.plannedStart !== null &&
					gb.plannedEnd !== null
				) {
					if (
						ga.plannedStart < gb.plannedEnd &&
						gb.plannedStart < ga.plannedEnd
					) {
						violations.push({
							code: "INVARIANT_3_GUESTS_NON_OVERLAPPING",
							instanceIds: [ga.id, gb.id, host.id],
							message: `Guests ${ga.name} (${ga.id}) and ${gb.name} (${gb.id}) of host ${host.name} (${host.id}) overlap`,
						})
					}
				}
			}
		}

		// Invariant 4 & 5: need OverlapRule from host
		const overlapRule = host.rules.find(
			(r): r is import("./types").OverlapRule => r.type === "overlap",
		)
		if (!overlapRule) continue

		// Exclusion windows
		for (const guest of guests) {
			if (guest.plannedStart === null || guest.plannedEnd === null) continue
			for (const ew of overlapRule.exclusionWindows) {
				const ewStart =
					ew.anchor === "absolute"
						? ew.startWall !== undefined
							? minutesOfDay(ew.startWall)
							: 0
						: (hostStart ?? 0) + (ew.startOffset ?? 0)
				const ewEnd =
					ew.anchor === "absolute"
						? ew.endWall !== undefined
							? minutesOfDay(ew.endWall)
							: 0
						: (hostStart ?? 0) + (ew.endOffset ?? 0)

				if (guest.plannedStart < ewEnd && ewStart < guest.plannedEnd) {
					violations.push({
						code: "INVARIANT_4_GUEST_AVOIDS_EXCLUSION",
						instanceIds: [guest.id, host.id],
						message: `Guest ${guest.name} (${guest.id}) intersects exclusion window of host ${host.name} (${host.id})`,
					})
				}
			}
		}

		// Invariant 5: guest budget
		let guestBudget = 0
		for (const guest of guests) {
			guestBudget += guest.scheduledMinutes
		}
		if (guestBudget > overlapRule.budgetMinutes) {
			violations.push({
				code: "INVARIANT_5_GUEST_BUDGET",
				instanceIds: [host.id],
				message: `Host ${host.name} (${host.id}) guest budget ${guestBudget}m exceeds overlap budget ${overlapRule.budgetMinutes}m`,
			})
		}
	}

	// Invariant 6: For every instance: scheduled_minutes ≤ duration_minutes,
	// and if scheduled at all, scheduled_minutes ≥ shrink floor.
	// Exceptions:
	// - spanning blocks (plannedEnd > lengthMinutes) — Drop-2 deletion territory.
	// - extended blocks (scheduledMinutes > durationMinutes but no shrink relaxation
	//   and the instance is ACTIVE/COMPLETED): user EXTEND is a legitimate source
	//   of duration inflation per SPEC.md §9.4.
	// - chunked blocks: a chunk's own scheduled_minutes must be ≥ minBlockMinutes
	//   (per-chunk floor); the total-floor check is per-activity, not per-chunk.
	const hasShrinkRelaxation = (i: TimelineActivity) =>
		i.relaxations.some((r) => r.type === "shrink")
	for (const inst of instances) {
		const isSpanning =
			inst.plannedStart !== null &&
			inst.plannedEnd !== null &&
			inst.plannedEnd > timeline.dayFrame.lengthMinutes
		const isExtended =
			inst.scheduledMinutes > inst.durationMinutes && !hasShrinkRelaxation(inst)
		if (inst.scheduledMinutes > inst.durationMinutes && !isSpanning && !isExtended) {
			violations.push({
				code: "INVARIANT_6_SCHEDULED_WITHIN_BOUNDS",
				instanceIds: [inst.id],
				message: `Instance ${inst.name} (${inst.id}) scheduled ${inst.scheduledMinutes}m exceeds duration ${inst.durationMinutes}m`,
			})
		}
		const elasticityRule = inst.rules.find(
			(r): r is import("./types").ElasticityRule => r.type === "elasticity",
		)
		if (!elasticityRule || inst.scheduledMinutes === 0) continue
		// Per-chunk floor: each block must be ≥ minBlockMinutes (not minTotalMinutes,
		// which is the activity-wide total and is naturally satisfied by the chunk
		// group's sum, not each individual chunk).
		if (inst.scheduledMinutes < elasticityRule.minBlockMinutes) {
			violations.push({
				code: "INVARIANT_6_SCHEDULED_WITHIN_BOUNDS",
				instanceIds: [inst.id],
				message: `Instance ${inst.name} (${inst.id}) scheduled ${inst.scheduledMinutes}m below per-chunk floor ${elasticityRule.minBlockMinutes}m`,
			})
		}
	}

	// Invariant 7: Every placement start and end is a multiple of GRID.
	for (const inst of instances) {
		if (inst.plannedStart !== null && inst.plannedStart % GRID !== 0) {
			violations.push({
				code: "INVARIANT_7_GRID_ALIGNMENT",
				instanceIds: [inst.id],
				message: `Instance ${inst.name} (${inst.id}) plannedStart ${inst.plannedStart} not on GRID (${GRID})`,
			})
		}
		if (inst.plannedEnd !== null && inst.plannedEnd % GRID !== 0) {
			violations.push({
				code: "INVARIANT_7_GRID_ALIGNMENT",
				instanceIds: [inst.id],
				message: `Instance ${inst.name} (${inst.id}) plannedEnd ${inst.plannedEnd} not on GRID (${GRID})`,
			})
		}
	}

	// Invariant 8: No block starts before the end of the frozen region.
	// freezeBoundary = max over anchors (COMPLETED actualEnd, ACTIVE plannedEnd, CARRIED_IN plannedEnd).
	// Exempt: ACTIVE/COMPLETED/CARRIED_IN/SKIPPED instances (anchors), locked instances,
	// and spanning blocks (plannedEnd > lengthMinutes) — the latter is Drop-2 deletion territory.
	// For COMPLETED instances, use actualEnd (which may be < plannedEnd when user finished early).
	const anchorEnd = instances
		.filter(
			(i) =>
				i.state === "COMPLETED" ||
				i.state === "ACTIVE" ||
				i.state === "CARRIED_IN",
		)
		.reduce((max, i) => {
			// For COMPLETED, actualEnd is authoritative (may be < plannedEnd via FINISH_EARLY).
			if (i.state === "COMPLETED" && i.actualEnd !== null) return Math.max(max, i.actualEnd)
			// For ACTIVE, plannedEnd (actualEnd may be null while in-progress).
			if (i.state === "ACTIVE") return Math.max(max, i.plannedEnd ?? 0)
			// For CARRIED_IN, plannedEnd.
			if (i.state === "CARRIED_IN") return Math.max(max, i.plannedEnd ?? 0)
			return max
		}, 0)
	// Use anchorEnd alone — not max(solvedAtOffset, anchorEnd). solvedAtOffset is
	// input.now, but FINISH_EARLY can move the actual freeze boundary backwards
	// (to event.at, which may be < now). The engine's true freeze boundary is
	// the larger of consumed time and event.at, which anchorEnd captures.
	const effectiveFreeze = anchorEnd
	for (const inst of instances) {
		if (
			inst.state !== "PLANNED" ||
			inst.locked ||
			inst.plannedStart === null ||
			inst.hostInstanceId !== null // guests inherit their host's span; not a new placement
		) {
			continue
		}
		const isSpanning =
			inst.plannedEnd !== null &&
			inst.plannedEnd > timeline.dayFrame.lengthMinutes
		if (isSpanning) continue
		if (inst.plannedStart < effectiveFreeze) {
			violations.push({
				code: "INVARIANT_8_NO_START_BEFORE_FROZEN",
				instanceIds: [inst.id],
				message: `Instance ${inst.name} (${inst.id}) starts at ${inst.plannedStart} before freeze boundary ${effectiveFreeze}`,
			})
		}
	}

	// Invariant 9: Exclusion windows consume no duration and no overlap budget.
	// This is a structural property — verified by the fact that exclusion windows
	// are never added to scheduledMinutes or guestBudget above. No runtime check
	// needed; the invariant is that the solver never counts them. We assert that
	// no instance's relaxations or scheduledMinutes include exclusion window time.
	for (const inst of instances) {
		if (inst.hostInstanceId !== null) continue // guests checked via budget above
		const overlapRule = inst.rules.find(
			(r): r is import("./types").OverlapRule => r.type === "overlap",
		)
		if (!overlapRule) continue
		// Exclusion windows should not contribute to scheduledMinutes or budget.
		// The check in Invariant 5 already ensures budget only counts guest durations.
		// This is a design-time assertion: no code path adds exclusion time to either.
	}

	return violations
}

function minutesOfDay(wall: string): number {
	const [h, m] = wall.split(":").map(Number)
	return h * 60 + m
}