# Phase 04 — The Solver

**Status:** Not Started
**Depends on:** 02, 03
**PRD refs:** §2, §5 stories 6, 12–13, 22

## Goal

Daily generation (Phase 01) becomes real: strict/immovable blocks are placed
first, then flexible/tracked activities fill the remaining gaps, prioritized
by rolling deficit from Phase 03, respecting each activity's window and
minimum block size. A warning badge appears when a target can't be fully
scheduled.

## Scope

- The Iterative Constraint Relaxation generator as a pure function: given
  strict blocks + flexible activities + deficits + windows/min-block-sizes,
  return a placement (or partial placement + shortfall).
- Wire this function into the Phase 01 generation path, replacing the naive
  clone-only placement.
- Warning badge on a `TimelineActivity`/`ActivityCard` when its target
  couldn't be fully scheduled (§5 story 22).

## Explicit non-goals

- No real-time recalculation from user actions (Finish Early, Extend) —
  Phase 05.
- No overlap-guest placement inside a host's budget — Phase 06 (though the
  solver must at least leave room for a host's declared overlap budget).

## First vertical slice

1. Pure function, unit-tested against a handful of hand-built scenarios
   (no gaps, one gap, insufficient room) before touching the app.
2. Wire into generation for the single-activity case, verify visually.
3. Expand to multiple competing flexible activities prioritized by deficit.
