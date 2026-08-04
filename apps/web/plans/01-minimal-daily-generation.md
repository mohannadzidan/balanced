# Phase 01 — Minimal Daily Generation

**Status:** Done
**Depends on:** 00, 02 (built after 02, not before — placing anything on the
timeline needs the Window Rule's start/end time, which didn't exist until
Phase 02 added rule attachment)
**PRD refs:** §5 story 6 (partial — naive placement, no priority/solver yet)

## Goal

Opening the app for a given date clones today's allowed Activity templates
into `TimelineActivity` rows and renders them through the real `Schedule` /
`TimelineSlot` components, replacing the current hardcoded mock content in
`components/chronos/schedule.tsx`. This is the first true end-to-end
checkpoint: create an activity in Phase 00, see it on today's timeline here.

## Scope

- A `timelineTable` / `timelineActivityTable` read+write path (Drizzle):
  get-or-create today's `Timeline`, clone matching `Activity` templates
  (by `allowed_days`) into `TimelineActivity` rows if not already generated.
- Naive placement only — no gap-filling, no conflict resolution, no rules
  applied. If two activities would collide, that's fine for now.
- `Schedule` renders real `TimelineActivity` rows instead of the current
  static `<HostActivity />`, `<OneTimeActivity />`, etc. mock tree.

## Explicit non-goals

- No solver, no priority-based gap filling — Phase 04.
- No rule enforcement (windows, overlap budgets, sequences) — Phases 02–04.
- No carry-over/tracking — Phase 03.
- No reality-divergence actions (Finish Early, Extend, etc.) — Phase 05.

## First vertical slice

1. Write the get-or-create-today's-Timeline query and a manual script/test
   to confirm it clones the right activities.
2. Render the cloned `TimelineActivity` rows with a minimal card (name +
   time range) in place of one mock block, verify visually.
3. Replace the rest of the mock tree in `Schedule` once the pattern holds.
