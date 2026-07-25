# Phase 11 — Focus Mode UI

**Status:** Not Started
**Depends on:** 05, 06
**PRD refs:** §5 stories 31–33

## Goal

Pressing "Start" on an upcoming activity enters a distraction-free Focus
Mode with a large countdown. Selecting a quick activity from the Phase 06
spare-time prompt enters Focus Mode directly. When a spare-time activity
ends, the user is automatically returned to the parent container's Focus
Mode timer.

## Scope

- Focus Mode screen/overlay with a large countdown
  (`components/chronos/active-focus-card.tsx` already mocks the entry
  point).
- Entry from a normal "Start" action and from the Phase 06 spare-time
  prompt.
- Auto-return to the parent's timer when a nested spare-time activity ends.

## Explicit non-goals

- No changes to the underlying timing/solver logic — this phase is
  presentation over state that already exists by Phase 05/06.

## First vertical slice

1. Focus Mode overlay + countdown for the "Start" entry path only.
2. Entry from the spare-time prompt.
3. Auto-return-to-parent behavior.
