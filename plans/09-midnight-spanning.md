# Phase 09 — Midnight Spanning

**Status:** Not Started
**Depends on:** 05
**PRD refs:** §5 stories 24–26

## Goal

An activity that runs past midnight has its overflow frozen as a locked
anchor in the next day's timeline, so the overnight generator can't displace
it. The overnight block shows a lock icon and "Spanning from yesterday"
label, and can be finished early from Focus Mode to record actual wake time
and free the remainder.

## Scope

- Detection: a `TimelineActivity` whose actual/expected end crosses
  midnight gets a corresponding locked `TimelineActivity` row seeded into
  the next day's `Timeline` before generation runs.
- Visual treatment: lock icon + label
  (`components/chronos/spanning-activity.tsx` already mocks this).
- "Finish early from Focus Mode" for a spanning block: records actual wake
  time, frees the remaining gap (reuses Phase 05's "Finish Early" path).

## Explicit non-goals

- No changes to the solver's daytime logic beyond treating the frozen
  anchor as another immovable block.

## First vertical slice

1. Detection + seeding of the locked next-day row for a manufactured
   spanning activity, verified by inspecting the DB.
2. Visual lock treatment on real data.
3. Finish-early wiring for the spanning case.
