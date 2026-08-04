# Implementation Plan: Manual Activity Scheduling & Timeline

**Branch**: `001-manual-activity-scheduling` | **Date**: 2026-07-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-manual-activity-scheduling/spec.md`

## Summary

Deliver the foundational daily timeline for `balanced` on a **rules-based** foundation: an
activity is a **global definition** carrying **typed rules**, and the timeline shows the blocks
those definitions produce for the current day. A user can view today's timeline, create Strict
activities (with optional pre/post transitions), create Flexible activities with a daily target
and minimum block, choose **exactly one Temporal Placement rule** per activity (Preferred Window
= Soft, or Strict Window = Hard), manually place Flexible blocks, and enable the system-wide
**Overlap Rule** on a Strict host so allowed guests can be scheduled _over_ it within a bounded
overlap budget. This is creation-and-viewing only (no edit/delete, no solver, no recurrence).

Technical approach: a Next.js 16.2 App Router app rendering the timeline as a Server Component
that reads the day through a single typed Turso (libSQL) data-access layer. Mutations run
through Server Actions that parse input with Zod, evaluate **pure rule functions**, persist via
the same data layer, and call `revalidatePath("/")` so the timeline updates without a manual
refresh. Rules are modeled as **one concrete table per rule category, keyed by activity id** —
which makes "at most one rule per category" a structural (primary-key) guarantee rather than
runtime bookkeeping, and avoids a generic rule engine (Constitution V). Rule **classification**
(Hard/Soft) is what the action branches on: a Hard violation rejects the write, a Soft violation
persists the block and returns a warning that the timeline renders as a flag. Time is stored as
integer minutes-from-midnight. **Overlap accounting is a first-class, separately-tested
concern**: overlapping wall-clock minutes are counted once, so a 30-minute guest inside an
8-hour host never yields 8h30m of logged time.

## Technical Context

**Language/Version**: TypeScript 5 (strict mode), React 19.2, Node.js 20

**Primary Dependencies**: Next.js 16.2.6 (App Router, Server Actions), shadcn/ui on Base UI
(`@base-ui/react`) + Tailwind CSS v4, `@libsql/client` (Turso), `zod` (boundary validation),
`lucide-react`

**Storage**: Turso (libSQL / SQLite) via a single typed data-access layer in `lib/db/`; schema
applied through checked-in SQL migration files

**Testing**: Pure rule-evaluation and accounting logic unit-tested with `vitest` (the primary
seam — see PRD "Testing Decisions"); manual quickstart validation for UI flows. Vitest is a new
dev dependency.

**Target Platform**: Modern browser (client) + Node.js server runtime for Server Actions

**Project Type**: Web application (Next.js App Router, single deployable — no separate
frontend/backend split)

**Performance Goals**: Timeline render and save round-trip feel instant on a single-user
local/hosted Turso DB (< 200 ms p95 for a create action excluding network); no bulk-scale goals

**Constraints**: TypeScript strict; no `any` without justification; all DB access through the
one data layer; rule categories mutually exclusive by construction; time arithmetic via a tested
utility, never string math; overlap minutes counted once (FR-026); current-date-only scope

**Scale/Scope**: Single user, one day's activities (tens of blocks at most); 4 user stories
(P1–P4), 26 functional requirements, 7 key entities, 3 rule categories (2 implemented, 1
deferred)

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                            | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Component-First UI (shadcn/ui)    | PASS   | All UI composed from `components/ui` primitives; missing ones (dialog, select, input, label, checkbox, card, badge) added via the shadcn CLI, never hand-rolled. The allowed-guest multi-select and the sidebar are **compositions** of primitives, not forks.                                                                                                                                                                                |
| II. Schedule Integrity & Correctness | PASS   | Every Hard rule (End>Start, Strict Window, host bounds, overlap budget, allowed-guest set) is evaluated server-side before persistence. Time stored as integer minutes-from-midnight, compared numerically via a tested `lib/time.ts` — no raw string date math. Overlap accounting (FR-026/SC-007) is its own tested module so the "counted once" guarantee is verified, not assumed. Single-date scope avoids timezone-instant comparisons. |
| III. Turso as Source of Truth        | PASS   | One typed data-access layer (`lib/db/queries.ts`) over one client (`lib/db/client.ts`); Server Actions and Server Components call only that layer. Schema via checked-in migrations. No ad-hoc connections or raw SQL elsewhere.                                                                                                                                                                                                              |
| IV. Type Safety End-to-End           | PASS   | Strict mode stays on. Zod parses every Server Action input; rule rows map to a discriminated union at the data-layer boundary (`TemporalPlacementRule` = preferred \| strict), so rule handling is exhaustive-checked by the compiler. No `any`.                                                                                                                                                                                              |
| V. Simplicity (YAGNI)                | PASS   | Rules are **concrete typed tables per category**, not a configurable rule engine — the constitution's named anti-pattern is avoided while still delivering the spec's rules model. Only 2 of 3 categories are built; **Recurrence is documented but not implemented** (spec Assumptions put it out of scope). No solver, carry-over, FCM, focus mode, or edit/delete.                                                                         |

**Stack constraints**: pnpm for all dependency ops. Next.js 16.2 APIs verified against
`node_modules/next/dist/docs/` per `AGENTS.md` — the `'use server'` + `useActionState(prevState,
formData)` pattern (`01-app/02-guides/forms.md`) and `revalidatePath(path)` semantics
(`01-app/03-api-reference/04-functions/revalidatePath.md`, which confirms Server Functions update
the UI immediately for the viewed path) were both read for this plan. Prettier + ESLint must
pass. No new database engine introduced.

**Note on a constitution wording drift (not a violation)**: Constitution I/Technology Stack
describe shadcn/ui as "Radix-based", but this repo's installed shadcn/ui sits on `@base-ui/react`
(shadcn's current primitive layer). The principle — compose from `components/ui`, add via the
CLI, never hand-roll — is followed exactly; only the underlying primitive vendor differs from the
constitution's prose. Worth a PATCH amendment to the constitution's wording at some point; no
plan deviation is required.

**Result**: PASS (initial) — no violations, Complexity Tracking not required.
**Post-Phase-1 re-check**: PASS — see [Post-Design Constitution Re-Check](#post-design-constitution-re-check).

## Project Structure

### Documentation (this feature)

```text
specs/001-manual-activity-scheduling/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── server-actions.md
│   └── data-access.md
├── checklists/
│   └── requirements.md  # (already present)
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
app/
├── layout.tsx                       # (existing) root layout + theme provider
├── page.tsx                         # Timeline route (Server Component): reads the day, renders timeline + sidebar
├── actions.ts                       # Server Actions: createActivity, scheduleFlexibleBlock, scheduleGuestBlock
└── globals.css                      # (existing)

components/
├── timeline/
│   ├── timeline.tsx                 # Ordered blocks for the current day
│   ├── timeline-block.tsx           # One block (strict / transition / flexible / guest-overlap variants)
│   ├── flexible-sidebar.tsx         # "Flexible Activities" list with daily-target progress
│   └── host-detail-panel.tsx        # Remaining overlap budget + "Schedule Inside" entry point
├── forms/
│   ├── add-activity-dialog.tsx      # Add Activity: constraint type, temporal placement choice, transitions, Overlap Rule
│   ├── schedule-flexible-dialog.tsx # Manual standalone Flexible block
│   └── schedule-guest-dialog.tsx    # Schedule an allowed guest over a host
├── theme-provider.tsx               # (existing)
└── ui/                              # (existing + newly added shadcn primitives)

lib/
├── db/
│   ├── client.ts                    # Single libSQL client (Turso) — the only connection point
│   ├── schema.ts                    # Raw row types per table
│   ├── queries.ts                   # Typed read/write functions (the data-access layer)
│   └── migrations/
│       └── 0001_init.sql            # Initial schema (activity + rule tables + blocks)
├── domain/
│   ├── types.ts                     # Activity, TemporalPlacementRule (union), OverlapRule, Transition, ScheduledBlock
│   ├── validation.ts                # Zod schemas for Server Action inputs
│   ├── rules.ts                     # Pure rule evaluation: window/overlap/host-bounds/budget/allowed-guest
│   └── accounting.ts                # Overlap-aware time accounting: progress, remaining budget, union minutes (FR-026)
├── time.ts                          # minutes-from-midnight helpers + formatting (tested utility)
└── utils.ts                         # (existing) cn()

tests/
└── unit/
    ├── rules.test.ts                # Rule evaluation, Hard vs Soft outcomes (primary seam)
    ├── accounting.test.ts           # Overlap counted once, progress, remaining budget (FR-026 / SC-007)
    └── time.test.ts                 # Time utility conversions
```

**Structure Decision**: Single Next.js App Router project (no frontend/backend split). The
timeline page is a Server Component reading through `lib/db/queries.ts`; all mutations are Server
Actions in `app/actions.ts` that parse with `lib/domain/validation.ts`, evaluate
`lib/domain/rules.ts`, derive budgets/progress via `lib/domain/accounting.ts`, persist through
`lib/db/queries.ts`, and `revalidatePath("/")`.

The important seam is that **rule evaluation and accounting are pure functions that never touch
the DB or the browser**. `rules.ts` answers "may this block exist, and if not, was the broken
rule Hard or Soft?"; `accounting.ts` answers "how much time does this actually represent?" —
which is where FR-026's count-once guarantee lives. Both are directly unit-testable, matching the
PRD's "primary seam" guidance and Constitution II. When the solver arrives in a later feature it
consumes these same pure functions rather than reimplementing the rules.

## Post-Design Constitution Re-Check

Re-evaluated after Phase 1 (data-model, contracts, quickstart) with no new violations:

- **I** — Design adds no bespoke widget: the guest multi-select, progress rows, and detail panel
  are compositions of `dialog/select/checkbox/card/badge`.
- **II** — Phase 1 made every Hard rule an explicit, server-evaluated precondition in
  [contracts/server-actions.md](./contracts/server-actions.md), and gave the count-once accounting
  rule its own module and test file. The Soft path is specified (persist + warn), so a Preferred
  Window violation can never be silently swallowed (FR-017 / SC-004).
- **III** — All Phase 1 reads/writes are expressed as functions on
  [contracts/data-access.md](./contracts/data-access.md); the multi-row activity+rules+transitions
  insert is specified as one atomic batch, so a half-created rule set cannot exist.
- **IV** — `TemporalPlacementRule` is a discriminated union on `kind`, so adding a future rule
  variant becomes a compile error at every switch rather than a silent fallthrough.
- **V** — Recurrence stayed a documented, unbuilt category; the single `scheduled_block` table
  (guest blocks are rows with a non-null `host_activity_id`) replaced the earlier design's second
  table, removing a whole entity while making guest minutes count toward guest progress for free.

**Result**: PASS.

## Complexity Tracking

> No Constitution violations — this section intentionally left empty.
