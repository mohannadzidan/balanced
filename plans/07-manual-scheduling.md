# Phase 07 — Manual Scheduling

**Status:** Not Started
**Depends on:** 04
**PRD refs:** §5 stories 20–21

## Goal

A user can manually place a flexible activity's block into a specific slot,
or manually place an allowed guest inside a host's overlap budget, instead
of relying on the solver's automatic placement.

## Scope

- UI to pick a flexible activity and a target slot, with the same
  window/overlap/no-conflict validation the solver would otherwise apply.
- UI to place a guest activity inside a host's remaining overlap budget at a
  specific time.

## Explicit non-goals

- No changes to the solver's own placement logic — this phase only adds a
  manual override path that respects the same rules.

## First vertical slice

1. Manual placement of a standalone flexible block into an empty gap,
   reusing Phase 04's validation checks.
2. Manual guest placement inside a host's budget.
