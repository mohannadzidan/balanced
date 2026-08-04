# Phase 02 — Rule Configuration

**Status:** Done
**Depends on:** 00
**PRD refs:** §3.2, §5 stories 2–4

## Goal

From an Activity's edit view, a user can attach a Window Rule, a Sequence
Rule (pre/post), and an Overlap Rule (host + allowed guests + budget) — each
stored as a typed row in `ruleTable` (`config` JSON), respecting "at most one
rule per type per activity."

## Scope

- Rule-type forms (likely within the same `Sheet` pattern from Phase 00, or
  a dedicated Activity edit sheet): Window (strict/flexible + start/end),
  Sequence (pre/post activity link), Overlap (budget minutes + guest
  activity picker via `overlapAllowedGuestTable`).
- Server Actions to upsert a rule row per type, enforcing the unique
  `(activityId, ruleType)` index already in the schema.
- `Schedule`/`ActivityCard` rendering picks up rule data where it's cheap to
  show (e.g. the "HOST" badge + overlap budget subtitle already mocked in
  `components/chronos/host-activity.tsx`).

## Explicit non-goals

- No solver behavior yet — rules are stored and displayed, not yet enforced
  during generation. Enforcement is Phase 04 (Solver) and Phase 06
  (Overlaps).
- No Tracking Rule (separate ledger concerns) — Phase 03.

## First vertical slice

1. Window Rule only: form + Server Action + upsert, verify round-trip via
   the DB and a simple display.
2. Sequence Rule, following the same shape.
3. Overlap Rule + guest picker, the most involved of the three.
