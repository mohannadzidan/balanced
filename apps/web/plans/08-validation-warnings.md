# Phase 08 — Validation & Warnings

**Status:** Not Started
**Depends on:** 04
**PRD refs:** §5 story 23 (story 22 already covered in Phase 04)

## Goal

Saving a strict activity that would overlap an existing immovable block is
rejected, forcing the user to resolve the conflict manually rather than
silently corrupting the timeline.

## Scope

- Conflict check on strict-activity save (template or timeline-level)
  against currently immovable blocks (strict windows, pinned blocks,
  midnight-spanning anchors once Phase 09 exists).
- Clear rejection messaging back through the Server Action's returned state.

## Explicit non-goals

- No auto-resolution or suggestion UI — rejection only, user resolves
  manually.

## First vertical slice

1. The conflict-check pure function + unit tests.
2. Wire into the strict-activity Server Action, verify a manufactured
   conflicting save is rejected end-to-end.
