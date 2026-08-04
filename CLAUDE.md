## Core Principles

### I. Component-First UI (shadcn/ui)

Every UI element MUST be built from shadcn/ui primitives (`apps/web/components/ui`, as
configured in `apps/web/components.json`) before any custom component is written from
scratch. New primitives
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

### V. Simplicity First (YAGNI)

Build only the scheduling features actually requested. Before writing code, answer "what is
the simplest thing that could work?" and implement that naive, obviously-correct version;
optimize only after correctness is demonstrated. Avoid speculative abstractions (plugin
systems, multi-tenant support, generic "activity framework" layers, config-driven form
builders, configurable rule engines) until a third concrete use case demands them — three
similar lines of code are preferable to a premature abstraction. Prefer Next.js App Router
conventions and shadcn/ui defaults over custom infrastructure.

After writing code, it MUST be reviewed against these checks before it is considered done:
can this be done in fewer lines; are these abstractions earning their complexity; would a
senior reviewer ask "why didn't you just…"; is this built for hypothetical future
requirements rather than the current task?

**Rationale**: `balanced` is a personal time-management tool, not a platform. Premature
generalization adds surface area to maintain without a second user or use case to justify
it.

### VI. Incremental Delivery (Thin Vertical Slices)

Any change touching more than one file MUST be delivered as a sequence of thin vertical
slices rather than a single large pass. Each slice MUST follow the cycle
**implement → test → verify → commit**, and MUST leave the repository in a working state:
the build succeeds, type checking passes, linting passes, and any existing tests still
pass. Single-file, single-function changes are exempt.

Slice rules:

1. **One thing at a time** — each increment changes one logical thing. A commit MUST NOT
   mix a new feature with an unrelated refactor or a build-config change.
2. **Keep it compilable** — the codebase MUST NOT be left broken between slices.
3. **Feature flags for incomplete work** — a feature that is not ready for users MUST be
   gated behind a flag (e.g. an env-driven constant) before its increments are merged, not
   after.
4. **Safe defaults** — new options and behaviors default to the conservative, opt-in value.
5. **Rollback-friendly** — each increment MUST be independently revertable. Prefer additive
   changes; keep modifications to existing code minimal and focused; give every database
   migration a corresponding rollback; do not delete and replace something in the same
   commit.

More than ~100 lines written without running the verification gates is a violation of this
principle, not a style preference.

**Rationale**: Bugs compound. A defect introduced in the first slice silently invalidates
every slice built on top of it, and a 500-line change offers no way to bisect which line
caused the failure. Small, verified, revertable increments are what make a scheduling
feature — where correctness bugs are invisible until a user's day is already wrong —
debuggable by a single maintainer.

### VII. Scope Discipline

Touch only what the task requires. The following are prohibited unless they are the task:

- "Cleaning up" code adjacent to the change
- Refactoring imports in files not otherwise being modified
- Removing comments whose purpose is not fully understood
- Adding features absent from the spec because they "seem useful"
- Modernizing syntax in files that are only being read

Improvements noticed outside the task's scope MUST be reported, not performed — list them
explicitly (file, issue, why it is out of scope) and let the maintainer decide whether they
become their own task.

**Rationale**: Unrequested edits inflate diffs, mix concerns that Principle VI works to
separate, and make it impossible to tell which change caused a regression. A noted
improvement costs one line; a smuggled refactor costs a debugging session.

## Technology Stack Constraints

- **Repo layout**: pnpm monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`).
  `apps/web` is the Next.js app; `apps/api` is a Fastify service (scaffold only — not
  yet wired to the brain engine or the DB layer); `packages/brain` is the framework-
  agnostic scheduling engine; `packages/typescript-config` and `packages/vitest-config`
  are the shared tsconfig/vitest bases every package extends. Root-level `pnpm <script>`
  commands fan out across the workspace (`pnpm -r run <script>`, or a single root-level
  invocation for oxlint/oxfmt, which cover the whole tree via nested config).
- **Framework**: Next.js 16.2 (App Router), matching the `apps/web/app/` structure.
  Next.js 16.2 has breaking changes relative to older training data — any code touching
  routing, data fetching, caching, or server actions MUST first be checked against
  `apps/web/node_modules/next/dist/docs/` per `AGENTS.md`.
- **UI**: shadcn/ui on Radix primitives with Tailwind CSS v4, as configured in
  `apps/web/components.json`.
- **Database**: Turso (libSQL) is the only persistence backend. Introducing another
  database or storage engine requires a constitution amendment. The data-access layer
  currently lives in `apps/web/lib/db`; `apps/api` will own DB access directly once it's
  wired up, at which point `apps/web` is expected to call it over HTTP rather than query
  Turso in-process (not yet done — tracked as follow-up work, not a current dual-write
  path).
- **Package manager**: pnpm (`pnpm-workspace.yaml`, `pnpm-lock.yaml`). All dependency
  operations MUST use pnpm, not npm or yarn.
- **Language**: TypeScript in strict mode across the codebase, via the shared
  `@balanced/typescript-config` base with per-runtime overrides (`nextjs.json`,
  `node.json`).
- **Formatting/Linting**: oxfmt and oxlint MUST pass before a change is considered
  complete. Root `.oxlintrc.json`/`.oxfmtrc.json` are the shared base; `apps/web` adds
  a nested `.oxlintrc.json` (`extends` the root config) for Next-specific rules only —
  oxfmt has no `extends` mechanism, so formatting stays a single root config.

## Development Workflow

- New UI work is composed from `apps/web/components/ui`; run `pnpm lint` and
  `pnpm typecheck` before considering any change complete.
- Before using a Next.js 16.2 API you have not verified in this codebase, consult
  `apps/web/node_modules/next/dist/docs/` rather than relying on prior training data
  (per `AGENTS.md`).
- Database schema changes go through explicit, reviewed migration files — never manual
  edits to a running database.
- Feature specs, plans, and tasks produced by `/speckit-specify`, `/speckit-plan`, and
  `/speckit-tasks` MUST verify compliance with these principles; any unavoidable deviation
  MUST be recorded in the plan's Complexity Tracking section with justification.

### Slicing Strategies

Plans and task breakdowns SHOULD pick one of these, in this order of preference:

- **Vertical slices (default)** — one complete path through the stack per slice (schema →
  data-access → server action → UI), so every slice delivers usable behavior. Example:
  create an activity, then list activities, then edit, then delete.
- **Contract-first** — when the data-access/server-action contract must be settled before
  UI and persistence proceed in parallel: define the contract and types first, build each
  side against it, then integrate end to end.
- **Risk-first** — when a slice carries genuine technical uncertainty (a Turso query
  pattern, a timezone/recurrence rule), prove that piece first so a failure is discovered
  before dependent work is built on it.

### Increment Checklist

Every increment MUST satisfy all of the following before the next slice begins:

- [ ] The change does one thing, and does it completely
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm build` succeeds
- [ ] Where a test suite covers the touched area, it passes; where the spec requested tests
      for this work, they exist and pass
- [ ] The new behavior works as specified (tests, or a documented manual check)
- [ ] The change is committed with a descriptive message

Run each gate after a change that could affect it. Re-running a gate that already passed,
with no intervening code change, adds no information and MUST NOT be used as reassurance.

`pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test` are all wired at the
workspace root and are the binding gates; `pnpm test` runs every package's Vitest suite
via `test.projects` in the root `vitest.config.ts`.

### Anti-Patterns

The following are treated as violations to be corrected, not preferences to be weighed:

- Deferring all testing to the end of a multi-slice feature
- Bundling unrelated changes into one increment, or one commit
- "While I'm here" scope expansion into files the task does not require
- Leaving the build or tests broken between slices
- Accumulating large uncommitted changes
- Introducing an abstraction before a third use case demands it
- Creating a new utility file for a one-time operation
- Adding a user-visible incomplete feature with the flag "to be added later"
