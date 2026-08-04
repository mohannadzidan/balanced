# Phase 03 — Tracking & Carry-Over

**Status:** Not Started
**Depends on:** 02
**PRD refs:** §3.3, §5 stories 5, 7–9

## Goal

An Activity can carry a Tracking Rule (daily target + carry-over toggle).
Opening the app on a new day lazily evaluates yesterday's `TimelineActivity`
completion against the ledger, rolls any deficit/surplus into
`trackingLedgerTable`, and computes today's adjusted target — before
generation runs.

## Scope

- Tracking Rule form (daily target minutes, carry-over on/off), same
  upsert pattern as Phase 02's other rule types.
- Lazy carry-over evaluation: on app open, for each tracked Activity, sum
  yesterday's logged `TimelineActivity` time, compare to that day's target,
  update `rollingTargetMinutes` / `rollingAchievedMinutes`.
- Daily target cap (prevents unbounded snowballing).
- Vacation-day marking that prorates a specific date's target to zero
  without creating a deficit.

## Explicit non-goals

- No solver placement of tracked activities by priority — Phase 04.
- No UI for viewing ledger history beyond what's needed to confirm this
  phase works.

## First vertical slice

1. Tracking Rule form + upsert, verified by reading it back.
2. Carry-over math as a pure function (unit-testable, mirroring the style
   of the old `lib/domain` pure-function modules) + a test.
3. Wire the pure function into the app-open path, verify a manufactured
   "missed yesterday" scenario increases today's target.
