<!--
Sync Impact Report
Version change: none (template) → 1.0.0
Modified principles: N/A (initial ratification)
Added sections:
  - Core Principles: I. Component-First UI, II. Schedule Integrity & Correctness,
    III. Turso as Source of Truth, IV. Type Safety End-to-End, V. Simplicity (YAGNI)
  - Technology Stack Constraints
  - Development Workflow
  - Governance
Removed sections: none
Templates requiring updates:
  - .specify/templates/plan-template.md ✅ no changes needed (Constitution Check gate is
    dynamically derived from this file; no hardcoded principle names to update)
  - .specify/templates/spec-template.md ✅ no changes needed (generic, technology-agnostic)
  - .specify/templates/tasks-template.md ✅ no changes needed (generic, technology-agnostic)
  - .claude/skills/speckit-*/SKILL.md ✅ reviewed, no outdated agent-specific references found
  - README.md ⚠ pending (still the generic Next.js template README; consider replacing with
    project-specific description referencing `balanced`, Turso, and scheduling domain)
Follow-up TODOs: none
-->

# Balanced Constitution

## Core Principles

### I. Component-First UI (shadcn/ui)

Every UI element MUST be built from shadcn/ui primitives (`components/ui`, as configured
in `components.json`) before any custom component is written from scratch. New primitives
MUST be added via `npx shadcn@latest add <component>`, not hand-copied or reimplemented.
Customization happens through composition, Tailwind utility classes, and variant props
(`class-variance-authority`); forking a primitive's internals is permitted only to fix an
accessibility or behavior defect, and MUST be documented inline with the reason.

**Rationale**: shadcn/ui already provides accessible, Radix-based, themeable primitives
wired into this repo. Reinventing them wastes effort, fragments the visual language, and
risks accessibility regressions that the library already solved.

### II. Schedule Integrity & Correctness

Scheduling logic (time slots, durations, overlaps, recurrence) MUST validate against
double-booking and invalid ranges before a task/activity is persisted. All stored and
compared time values MUST be UTC (or an unambiguous instant representation); conversion to
the user's local timezone happens only at the display layer, never inside comparison or
storage logic. Any date/time arithmetic MUST use a vetted library or well-tested utility,
never raw string manipulation of dates.

**Rationale**: `balanced` exists to produce a trustworthy daily schedule. A timezone or
overlap bug silently corrupts the one thing the app promises — an accurate plan for the
user's day — so correctness here is non-negotiable rather than a nice-to-have.

### III. Turso as Source of Truth

All persistent task and schedule data MUST be read and written through a single typed
data-access layer backed by Turso (libSQL). No route, component, or server action may open
an ad-hoc database connection or issue raw queries outside that layer. Schema changes MUST
be made through migrations checked into the repo, never as manual edits against a live
database.

**Rationale**: Turso is the sole persistence backend for this app. A single access layer
keeps queries auditable, keeps local/dev/prod schemas in sync, and prevents the kind of
drift that turns "where is this data actually written" into a debugging session.

### IV. Type Safety End-to-End

TypeScript strict mode MUST remain enabled. Database rows, server-action inputs/outputs,
and scheduling domain objects (tasks, time blocks, activities) MUST have explicit types
validated at I/O boundaries (Turso query results, form/input parsing) — for example via a
schema-validation library such as Zod. Use of `any` is prohibited unless accompanied by an
inline comment justifying why a precise type is not possible.

**Rationale**: Scheduling data flows from user input through server logic into Turso and
back into the UI. Untyped boundaries are exactly where date/time, ID, and null-handling
bugs hide, and this is a single-maintainer app with no separate QA safety net.

### V. Simplicity (YAGNI)

Build only the scheduling features actually requested. Avoid speculative abstractions
(plugin systems, multi-tenant support, generic "activity framework" layers, configurable
rule engines) until a second concrete use case demands them. Prefer Next.js App Router
conventions and shadcn/ui defaults over custom infrastructure.

**Rationale**: `balanced` is a personal time-management tool, not a platform. Premature
generalization adds surface area to maintain without a second user or use case to justify
it.

## Technology Stack Constraints

- **Framework**: Next.js 16.2 (App Router), matching the `app/` structure already
  scaffolded in this repo. Next.js 16.2 has breaking changes relative to older training
  data — any code touching routing, data fetching, caching, or server actions MUST first
  be checked against `node_modules/next/dist/docs/` per `AGENTS.md`.
- **UI**: shadcn/ui on Radix primitives with Tailwind CSS v4, as configured in
  `components.json`.
- **Database**: Turso (libSQL) is the only persistence backend. Introducing another
  database or storage engine requires a constitution amendment.
- **Package manager**: pnpm (`pnpm-workspace.yaml`, `pnpm-lock.yaml`). All dependency
  operations MUST use pnpm, not npm or yarn.
- **Language**: TypeScript in strict mode across the codebase.
- **Formatting/Linting**: Prettier (with `prettier-plugin-tailwindcss`) and ESLint
  (`eslint-config-next`) MUST pass before a change is considered complete.

## Development Workflow

- New UI work is composed from `components/ui`; run `pnpm lint` and `pnpm typecheck`
  before considering any change complete.
- Before using a Next.js 16.2 API you have not verified in this codebase, consult
  `node_modules/next/dist/docs/` rather than relying on prior training data (per
  `AGENTS.md`).
- Database schema changes go through explicit, reviewed migration files — never manual
  edits to a running database.
- Feature specs, plans, and tasks produced by `/speckit-specify`, `/speckit-plan`, and
  `/speckit-tasks` MUST verify compliance with these principles; any unavoidable deviation
  MUST be recorded in the plan's Complexity Tracking section with justification.

## Governance

This constitution supersedes ad hoc conventions and prior undocumented practice.
Amendments are made by editing this file, incrementing the version per semantic
versioning (MAJOR for incompatible principle removals/redefinitions, MINOR for new or
materially expanded principles/sections, PATCH for clarifications and wording fixes), and
prepending an updated Sync Impact Report. Every amendment MUST re-check the dependent
templates listed in the Sync Impact Report and update them if the change affects their
content.

All feature plans and code changes MUST be checked against these principles; unjustified
complexity or stack deviations must be flagged rather than silently introduced. Use
`AGENTS.md` alongside this constitution for day-to-day runtime development guidance.

**Version**: 1.0.0 | **Ratified**: 2026-07-24 | **Last Amended**: 2026-07-24
