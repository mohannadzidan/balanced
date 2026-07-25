# Balanced — Phased Roadmap

Tracks the build-out of `PRD.md` as small, independently testable phases.
Each phase is built in thin vertical slices (implement → test → verify →
commit) rather than all at once. See the phase file for scope; deep
step-by-step implementation plans are written per-phase, just before that
phase starts.

| # | Phase | Status | Depends on |
|---|-------|--------|------------|
| 00 | [Activity CRUD](00-activity-crud.md) | Done | — |
| 01 | [Minimal Daily Generation](01-minimal-daily-generation.md) | Done | 00, 02 (built after 02 — needed Window Rule data) |
| 02 | [Rule Configuration](02-rule-configuration.md) | Done | 00 |
| 03 | [Tracking & Carry-Over](03-tracking-and-carryover.md) | Not Started | 02 |
| 04 | [The Solver](04-solver.md) | Not Started | 02, 03 |
| 05 | [Execution & Reality Divergence](05-execution-divergence.md) | Not Started | 04 |
| 06 | [Overlaps & Spare Time](06-overlaps-and-spare-time.md) | Not Started | 02, 04 |
| 07 | [Manual Scheduling](07-manual-scheduling.md) | Not Started | 04 |
| 08 | [Validation & Warnings](08-validation-warnings.md) | Not Started | 04 |
| 09 | [Midnight Spanning](09-midnight-spanning.md) | Not Started | 05 |
| 10 | [Notifications & Auto-Start](10-notifications-autostart.md) | Not Started | 05 |
| 11 | [Focus Mode UI](11-focus-mode-ui.md) | Not Started | 05, 06 |

## Notes

- `lib/db/schema.ts` already implements the PRD's full polymorphic rules
  model (`activity`, `rule`, `trackingLedger`, `overlapAllowedGuest`,
  `timeline`, `timelineActivity`, `timelineRule`, `timelineOverlapGuest`) —
  no schema changes are expected for the early phases.
- `lib/domain/*`, `app/actions.ts`, `tests/unit/*`, and
  `specs/001-manual-activity-scheduling/*` predate that schema and are out of
  sync with it (`npx tsc --noEmit` currently fails because of this drift).
  These phases add fresh files rather than building on that stale layer.
