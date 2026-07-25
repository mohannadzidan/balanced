# Phase 00 — Activity CRUD

**Status:** Done
**Depends on:** none
**PRD refs:** §5 story 1 (author global Activity templates + `allowed_days`)

## Goal

A user can create a bare Activity template (name + which days it's allowed
on) through a bottom-sheet form, and see it persisted via Drizzle. No rules,
no timeline generation yet — this phase only proves the template layer and
the form UX end-to-end.

## Scope

- A reusable bottom-sheet `Sheet` UI primitive wrapping `@base-ui/react`'s
  `drawer` export, styled to match the existing `components/ui/*` primitives
  (see `components/ui/dialog.tsx` for the wrapping pattern this repo uses).
- An "Add Activity" form (name + allowed-days picker) rendered inside the
  `Sheet`, opened from `ActionBar`'s existing "Add Activity" button
  (`components/chronos/action-bar.tsx`).
- A Server Action that validates the input (Zod) and inserts into
  `activityTable` via Drizzle (`lib/db/index.ts`).
- Some minimal visible confirmation that the insert worked (e.g. a simple
  list of existing activities, or a toast) — doesn't need to be the final UI.

## Explicit non-goals

- No rules (Window/Overlap/Sequence/Tracking) — Phase 02.
- No timeline generation or rendering on the schedule — Phase 01.
- No editing or deleting activities yet — create-only.
- Not touching/fixing `lib/domain/*` or `app/actions.ts` — new code lives in
  fresh files.

## First vertical slice

1. Build the `Sheet` primitive alone (open/close, bottom-anchored, no form
   content) and verify it opens from a temporary trigger.
2. Add the form fields + client-side validation, no submission yet.
3. Wire the Server Action + Drizzle insert, verify a row lands in the DB.
4. Wire the form to the real "Add Activity" button and confirm the
   end-to-end path manually (per this project's manual-UI-testing
   preference — no automated browser driving).
