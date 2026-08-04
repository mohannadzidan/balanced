# Phase 05 — Execution & Reality Divergence

**Status:** Not Started
**Depends on:** 04
**PRD refs:** §5 stories 10–15

## Goal

The schedule reacts to reality: a one-off on-demand activity can be added
directly to today's timeline; "Finish Early" logs actual time and re-runs
the solver over the freed gap, preferring activities with an outstanding
deficit and respecting minimum block sizes; "Extend +15m" validates against
and nudges subsequent blocks; a flexible block can be pinned to become
immovable.

## Scope

- One-off `TimelineActivity` creation with no `sourceActivityId` (doesn't
  touch templates).
- "Finish Early" action: records `actualEndTime`, frees the gap, re-invokes
  the Phase 04 solver scoped to that gap.
- "Extend +15m" action: validates against the next block, nudges
  lower-priority blocks forward if needed.
- "Pin Block" toggle (`isPinned` already in `timelineActivityTable`) that
  the solver treats as a hard constraint.

## Explicit non-goals

- Overlap/guest-specific spare-time banking and the quick-task prompt —
  Phase 06 (this phase's "Finish Early" is for non-overlapping blocks).
- Midnight-spanning specifics — Phase 09.

## First vertical slice

1. One-off activity creation (simplest, no solver interaction).
2. "Finish Early" against a single trailing block with an empty gap after
   it (no re-solve needed yet) — record actual time, confirm gap appears.
3. Re-invoke the solver over the freed gap.
4. "Extend +15m" and "Pin Block" as follow-on slices.
