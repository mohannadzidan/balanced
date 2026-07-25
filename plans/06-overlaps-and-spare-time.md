# Phase 06 — Overlaps & Spare Time

**Status:** Not Started
**Depends on:** 02, 04
**PRD refs:** §3.4, §5 stories 16–19

## Goal

Guest activities render nested inside their host's container on the
timeline. Finishing a guest activity early banks the leftover time as
transient (non-persisted) solver state and prompts the user with
allowed-interrupter options sized to fit; picking one enters Focus Mode
immediately, or the user can discard and just rest.

## Scope

- Nested host/guest rendering (`components/chronos/host-activity.tsx`,
  `guest-activity.tsx` already mock this visually — wire to real data).
- Detecting a guest finishing early within its host's overlap budget.
- In-memory spare-time bank + prompt UI offering allowed guests whose
  minimum block size fits the remaining time.
- Selecting a prompt option enters Focus Mode (ties into Phase 11); discard
  just clears the transient state.

## Explicit non-goals

- Spare time is never persisted as its own entity per the PRD — don't add a
  table for it.
- Manual placement of a guest into a host's budget — Phase 07.

## First vertical slice

1. Real host/guest rendering from `TimelineActivity` + `timelineOverlapGuestTable`
   data (no spare-time logic yet).
2. Spare-time computation on guest "Finish Early" as an in-memory value,
   verified via a log/temporary UI before building the prompt.
3. The prompt UI + quick-activity selection.
