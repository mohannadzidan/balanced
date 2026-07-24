# Tasks: Manual Activity Scheduling & Timeline

**Input**: Design documents from `/specs/001-manual-activity-scheduling/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/server-actions.md](./contracts/server-actions.md), [contracts/data-access.md](./contracts/data-access.md), [quickstart.md](./quickstart.md)

**Tests**: Unit tests ARE requested for this feature — plan.md Technical Context names `vitest` on
the pure logic seam (`lib/domain/rules.ts`, `lib/domain/accounting.ts`, `lib/time.ts`) and
quickstart.md specifies the expected coverage. UI flows are validated manually via quickstart.md;
no component or E2E tests are in scope.

**Organization**: Tasks are grouped by user story (US1–US4 = spec priorities P1–P4) so each story
is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Exact file paths are included in every task

## Path Conventions

Single Next.js App Router project at the repository root (plan.md "Project Structure"):
`app/`, `components/`, `lib/`, `tests/`. No frontend/backend split.

**Existing files** (do not recreate): `app/layout.tsx`, `app/page.tsx`, `app/globals.css`,
`components/theme-provider.tsx`, `components/ui/button.tsx`, `lib/utils.ts`.

**Per-task gate** (Constitution VI): each task ends with `pnpm typecheck`, `pnpm lint`, and — once
it exists — `pnpm test` passing, then a commit. Do not batch tasks before verifying.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies, tooling, and UI primitives needed by every story

- [X] T001 Add runtime dependencies with `pnpm add @libsql/client zod` and confirm they land in `package.json` / `pnpm-lock.yaml` (research §8, §9)
- [X] T002 Add `pnpm add -D vitest`, create `vitest.config.ts` at the repository root (include `tests/**/*.test.ts`, node environment), and add `"test": "vitest run"` to the `scripts` block of `package.json`
- [X] T003 [P] Add the shadcn primitives with `pnpm dlx shadcn@latest add dialog select input label checkbox card badge` — they must land in `components/ui/` via the CLI, never hand-written (Constitution I, research §11)
- [X] T004 [P] Create `.env.example` documenting `TURSO_DATABASE_URL` (e.g. `file:local.db`) and `TURSO_AUTH_TOKEN`, and add `.env.local` plus `local.db*` to `.gitignore`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Time utility, domain types, database schema/client, and the rule-verdict primitives
that every user story builds on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T005 [P] Implement `lib/time.ts`: `parseHHMM`/`formatHHMM` (`"HH:MM"` ⇄ minutes-from-midnight 0–1439), `durationMin`, `rangesOverlap`, `rangeContains`, and `todayISO()` returning the local `YYYY-MM-DD` date — all numeric, no string date math (Constitution II, research §10)
- [ ] T006 [P] Define the domain types in `lib/domain/types.ts` exactly as specified in data-model.md "Domain types": `PreferredWindow`, `StrictWindow`, `TemporalPlacementRule` (discriminated on `kind`), `OverlapRule`, `StrictActivity`, `FlexibleActivity`, `Activity`, `Transition`, `ScheduledBlock`
- [ ] T007 [P] Write the schema migration `lib/db/migrations/0001_init.sql` creating all six tables per data-model.md — `activity`, `temporal_placement_rule` (PK `activity_id`), `overlap_rule` (PK `host_activity_id`), `overlap_allowed_guest` (composite PK + `CHECK (guest_activity_id <> host_activity_id)`), `transition` (`UNIQUE (activity_id, position)`), `scheduled_block` — with `ON DELETE CASCADE` FKs and the four indexes listed under "Referential integrity & indexing"
- [ ] T008 [P] Create `lib/db/client.ts` exporting the single configured libSQL client from `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — the only connection point in the codebase (Constitution III)
- [ ] T009 Write `tests/unit/time.test.ts` covering `"HH:MM"` ⇄ minutes round-trips, boundary values (0, 1439), duration math, and the overlap/containment predicates
- [ ] T010 Declare the raw row types (one per table, SQLite-shaped: integers for booleans, text for dates) in `lib/db/schema.ts`
- [ ] T011 Create `scripts/migrate.ts` that applies pending `lib/db/migrations/*.sql` files in filename order against the configured client, add `"db:migrate": "tsx scripts/migrate.ts"` (or a node-run equivalent) to `package.json`, and verify it creates all six tables against `file:local.db`
- [ ] T012 Create `lib/domain/validation.ts` with the shared `ActionState` type from contracts/server-actions.md and reusable Zod field schemas (`minuteOfDay` = int 0–1439, non-empty `name`, positive-int duration, FormData coercion helpers)
- [ ] T013 Create `lib/domain/rules.ts` with the `RuleVerdict` type (`{ ok: true } | { ok: false; classification: "hard" | "soft"; message: string }`), the `ok()`/`hard()`/`soft()` constructors, and `checkEndAfterStart(startMin, endMin)` returning a **hard** verdict when `endMin <= startMin` (research §5, FR-005)
- [ ] T014 Write `tests/unit/rules.test.ts` covering the verdict constructors and `checkEndAfterStart` (equal times and reversed times both reject as hard; a valid range passes)

**Checkpoint**: Schema applies, time and verdict primitives are tested — user story work can begin

---

## Phase 3: User Story 1 - View the daily timeline and record a fixed activity (Priority: P1) 🎯 MVP

**Goal**: The app renders the current day's timeline (empty when there is no data) and the user can
create a Strict activity that appears immediately as a single correctly-positioned block.

**Independent Test**: Open the app with an empty database → timeline renders with no blocks. Create
"Morning Standup" (Strict, 10:00–10:30) → returned to the timeline, one block spanning 10:00–10:30,
no manual refresh. Submit End = Start → rejected, nothing persisted.

### Implementation for User Story 1

- [ ] T015 [US1] Implement `getDayView(date)` in `lib/db/queries.ts` returning `{ activities, transitions, blocks }` — this slice reads `activity` joined to `temporal_placement_rule` for `created_date = date` and maps rows to `Activity` domain objects with `placement` attached; `transitions` and `blocks` return empty arrays until US2/US3 (contracts/data-access.md)
- [ ] T016 [US1] Implement `insertActivityWithRules` in `lib/db/queries.ts` writing the `activity` row and its required `temporal_placement_rule` row as **one atomic libSQL batch** — an activity without its placement rule must be unrepresentable (contracts/data-access.md "Atomic multi-row writes")
- [ ] T017 [P] [US1] Add the strict-variant `createActivitySchema` to `lib/domain/validation.ts`: `name`, `constraintType: "strict"`, `placementKind: "strict"`, `placementStartMin`/`placementEndMin`, discriminated on `constraintType` so flexible-only fields are unrepresentable here (contracts/server-actions.md §1)
- [ ] T018 [P] [US1] Add `checkStrictActivityPlacement` to `lib/domain/rules.ts` — enforces `placementEndMin > placementStartMin` and that a strict activity's rule `kind` is `"strict"`, returning **hard** verdicts (data-model.md §2)
- [ ] T019 [US1] Extend `tests/unit/rules.test.ts` with strict-placement cases: End ≤ Start rejects hard (FR-005, AS-4); `kind: "preferred"` on a strict activity rejects hard; a valid 10:00–10:30 window passes
- [ ] T020 [US1] Implement the `createActivity(prev, formData)` Server Action in `app/actions.ts` (`'use server'`): Zod `safeParse` → rule verdicts → `insertActivityWithRules` → `revalidatePath("/")`, returning `ActionState` per contracts/server-actions.md (errors returned, never thrown; no partial writes)
- [ ] T021 [P] [US1] Create `components/timeline/timeline-block.tsx` rendering one block (label + `HH:MM–HH:MM` via `lib/time.ts`) with a variant prop, using `components/ui/card` and `components/ui/badge`
- [ ] T022 [US1] Create `components/timeline/timeline.tsx` — takes the `getDayView` result, derives one block per strict activity from its Strict Window, sorts by `startMin`, renders them via `timeline-block.tsx`, and renders the empty state when there are no blocks (FR-001, FR-002, FR-008, research §12)
- [ ] T023 [US1] Create `components/forms/add-activity-dialog.tsx` (client component) — shadcn `dialog`/`input`/`label`/`select`, Name + Constraint Type ("Strict") + Start/End time fields, submitting to `createActivity` via `useActionState(action, initialState)` and rendering `fieldErrors`/`formErrors` from state
- [ ] T024 [US1] Rewrite `app/page.tsx` as a Server Component: call `getDayView(todayISO())`, render `<Timeline>` plus the Add Activity dialog trigger, replacing the Next.js starter content

**Checkpoint**: User Story 1 is fully functional — empty timeline, create a Strict activity, see it
immediately (SC-001)

---

## Phase 4: User Story 2 - Attach pre- and post-transitions to an activity (Priority: P2)

**Goal**: Optional pre/post transitions are created alongside an activity, persisted linked to it,
and rendered as adjacent chronological blocks.

**Independent Test**: Create "Office Work" (Strict, 10:00–18:00) with pre "Commute" (08:00–10:00)
and post "Commute Home" (18:00–19:30) → three blocks render in chronological order. Repeat with
only a pre-transition → exactly two blocks persist and render.

### Implementation for User Story 2

- [ ] T025 [US2] Extend `insertActivityWithRules` in `lib/db/queries.ts` to write 0–2 `transition` rows inside the same atomic batch as the activity and its placement rule (FR-010)
- [ ] T026 [US2] Extend `getDayView` in `lib/db/queries.ts` to populate the `transitions` array for the day's activities, mapped to the `Transition` domain type
- [ ] T027 [P] [US2] Extend `createActivitySchema` in `lib/domain/validation.ts` with optional `preName`/`preStartMin`/`preEndMin` and `postName`/`postStartMin`/`postEndMin` groups (each all-or-nothing, at most one of each position)
- [ ] T028 [P] [US2] Add `checkTransitions` to `lib/domain/rules.ts` returning a **hard** verdict when any supplied transition has `endMin <= startMin`, with no adjacency enforcement against the parent activity (data-model.md §4, Edge Case)
- [ ] T029 [US2] Extend `tests/unit/rules.test.ts` with transition cases: invalid range rejects hard; a gap between transition and parent is accepted; pre-only input is valid
- [ ] T030 [US2] Extend `createActivity` in `app/actions.ts` to evaluate `checkTransitions` and pass the parsed transitions through to `insertActivityWithRules`
- [ ] T031 [US2] Add "Add Pre-Transition" / "Add Post-Transition" checkboxes to `components/forms/add-activity-dialog.tsx`, each revealing Name/Start/End fields when enabled (FR-009)
- [ ] T032 [US2] Merge transitions into the ordered block list in `components/timeline/timeline.tsx` and add a visually distinct `transition` variant in `components/timeline/timeline-block.tsx` (FR-011, SC-008)

**Checkpoint**: User Stories 1 AND 2 both work independently

---

## Phase 5: User Story 3 - Define and manually schedule flexible activities (Priority: P3)

**Goal**: Flexible activities carry a daily target, a minimum block, and exactly one Temporal
Placement rule; the sidebar tracks progress; manual blocks are validated Hard vs Soft and update
the timeline and sidebar in the same interaction.

**Independent Test**: Create "Freelance" (Flexible, target 4h, min block 2h, Preferred Window
18:00–23:00) → sidebar shows "0h / 4h". Schedule a block at 19:00 → timeline shows 19:00–21:00 and
sidebar shows "2h / 4h". Schedule at 08:00 → **saved and flagged** (soft). Repeat with a Strict
Window activity outside its window → **rejected**. Overlapping an existing block → **rejected**.

### Implementation for User Story 3

- [ ] T033 [US3] Extend `getDayView` in `lib/db/queries.ts` to populate `blocks` from `scheduled_block` for the date, mapped to the `ScheduledBlock` domain type (both `hostActivityId === null` and non-null rows)
- [ ] T034 [US3] Implement `getOccupiedRanges(date)` in `lib/db/queries.ts` returning every occupied interval for the day — strict activity spans, transitions, and scheduled blocks (contracts/data-access.md)
- [ ] T035 [US3] Implement `insertScheduledBlock(block)` in `lib/db/queries.ts`, writing one `scheduled_block` row with `host_activity_id = NULL` for standalone blocks
- [ ] T036 [P] [US3] Extend `lib/domain/validation.ts`: add the flexible variant of `createActivitySchema` (`dailyTargetMin`, `minBlockMin` positive ints, `placementKind: "preferred" | "strict"` + window, both windows unrepresentable together per FR-013) and add `scheduleFlexibleBlockSchema` (`activityId`, `startMin`)
- [ ] T037 [P] [US3] Add to `lib/domain/rules.ts`: `evaluatePlacement(rule, startMin, endMin)` returning **hard** for a `"strict"` window violation and **soft** for a `"preferred"` window violation (FR-016/FR-017), and `checkNoOverlap(range, occupiedRanges)` returning a **hard** verdict on any positive-length intersection
- [ ] T038 [US3] Extend `tests/unit/rules.test.ts`: strict-window violation ⇒ `classification: "hard"`; preferred-window violation ⇒ `classification: "soft"`; block fully inside the window passes; touching endpoints do not count as overlap; genuine intersection rejects hard
- [ ] T039 [P] [US3] Create `lib/domain/accounting.ts` with `activityProgressMin(activityId, blocks)` = Σ of that activity's own block durations for the date, with over-target values reported and never capped (data-model.md "Time accounting")
- [ ] T040 [US3] Create `tests/unit/accounting.test.ts` covering `activityProgressMin`: zero blocks ⇒ 0; two blocks sum; over-target totals are returned uncapped (Edge Case)
- [ ] T041 [US3] Implement the `scheduleFlexibleBlock(prev, formData)` Server Action in `app/actions.ts`: parse → load the flexible activity → compute `endMin = startMin + minBlockMin` → `evaluatePlacement` → `checkNoOverlap` against `getOccupiedRanges` → persist on pass or soft violation (returning `warnings`), reject on hard → `revalidatePath("/")` (contracts/server-actions.md §2)
- [ ] T042 [US3] Extend `createActivity` in `app/actions.ts` to handle the flexible branch (daily target, min block, chosen placement kind) through the same atomic insert
- [ ] T043 [US3] Extend `components/forms/add-activity-dialog.tsx`: selecting Constraint Type "Flexible" replaces Start/End with Daily Target, Minimum Block, and an **exclusive** Temporal Placement choice (Preferred *or* Strict window — selecting one clears the other) (FR-012, FR-013, AS-1/AS-2)
- [ ] T044 [P] [US3] Create `components/timeline/flexible-sidebar.tsx` listing each Flexible activity with `activityProgressMin` versus its daily target as "Xh / Yh" (FR-014, SC-003)
- [ ] T045 [P] [US3] Create `components/forms/schedule-flexible-dialog.tsx` — pick a flexible activity, enter a start time, submit to `scheduleFlexibleBlock` via `useActionState`, and surface returned `warnings` distinctly from `formErrors`
- [ ] T046 [US3] Render standalone flexible blocks in `components/timeline/timeline.tsx` and add the derived soft-violation badge in `components/timeline/timeline-block.tsx` — a block outside its activity's Preferred Window is badged at render time, never stored (FR-017, SC-004, research §5)
- [ ] T047 [US3] Wire `<FlexibleSidebar>` and the Schedule Block trigger into `app/page.tsx` from the same `getDayView` result

**Checkpoint**: User Stories 1, 2 AND 3 are independently functional

---

## Phase 6: User Story 4 - Overlap a host activity with allowed guests (Overlap Rule) (Priority: P4)

**Goal**: A Strict activity can host the system-wide Overlap Rule (budget + allowed-guest set);
allowed guests are scheduled over it within its bounds and remaining budget, rendered layered over
the host, with overlapping minutes counted exactly once.

**Independent Test**: Create "Fulltime Work" (Strict, 10:00–18:00, budget 60, guests ["Lunch"]) →
detail panel shows "Interruptible Capacity: 60 mins". Schedule Lunch at 13:00 → guest block renders
over the host, panel shows 30 mins remaining, host still reports its full 8h span (not 8h30m), and
Lunch's sidebar progress increases by 30m. Disallowed guest / past host end / over budget → all
rejected.

### Implementation for User Story 4

- [ ] T048 [US4] Extend `insertActivityWithRules` in `lib/db/queries.ts` to write the `overlap_rule` row and its `overlap_allowed_guest` rows inside the same atomic batch — a host without its guest rows must never be observable (FR-020)
- [ ] T049 [US4] Extend `getDayView` and `getActivityById` in `lib/db/queries.ts` to attach `overlap` (budget + `allowedGuestIds`) to strict activities that have an `overlap_rule` row, and implement `getActivityById(id)` returning a fully rule-attached `Activity | null`
- [ ] T050 [US4] Implement `getGuestBlocksForHost(hostActivityId, date)` in `lib/db/queries.ts`, plus guest-block support in `insertScheduledBlock` (non-null `host_activity_id`)
- [ ] T051 [P] [US4] Extend `lib/domain/validation.ts`: add the optional Overlap Rule fields to the strict branch of `createActivitySchema` (`overlapEnabled`, `overlapBudgetMin` ≥ 0, `allowedGuestIds[]`) and add `scheduleGuestBlockSchema` (`hostActivityId`, `guestActivityId`, `startMin`)
- [ ] T052 [P] [US4] Add to `lib/domain/rules.ts` — all returning **hard** verdicts (FR-023): `checkGuestAllowed(hostOverlapRule, guestActivityId)`, `checkWithinHostBounds(hostPlacement, startMin, endMin)`, `checkWithinBudget(durationMin, remainingBudgetMin)`, and `checkOverlapRuleEligibility` (host must be strict, guests must be flexible, no self-reference)
- [ ] T053 [US4] Extend `tests/unit/rules.test.ts`: guest not in the allowed set rejects; a 30m guest starting 17:45 against an 18:00 host end rejects (Edge Case); duration exceeding remaining budget rejects; a self-referencing guest rejects; an empty allowed-guest set is a valid host configuration
- [ ] T054 [P] [US4] Extend `lib/domain/accounting.ts` with `remainingOverlapBudgetMin(overlapRule, guestBlocks)`, `hostLoggedDurationMin(host)` (its own span, never adjusted by guests), and `unionMinutes(ranges)` (union measure, not a sum)
- [ ] T055 [US4] Extend `tests/unit/accounting.test.ts` with the FR-026 / SC-007 guarantee: 10:00–18:00 host + 13:00–13:30 guest ⇒ `unionMinutes` = **480**, not 510; `hostLoggedDurationMin` unchanged by guests; the guest's 30 minutes count toward the *guest's* progress; remaining budget decreases by exactly the guest duration
- [ ] T056 [US4] Extend `createActivity` in `app/actions.ts` to evaluate the Overlap Rule checks and persist the host's budget and allowed-guest set (rejecting overlap fields on a flexible activity)
- [ ] T057 [US4] Implement the `scheduleGuestBlock(prev, formData)` Server Action in `app/actions.ts`: load host (strict + `overlap_rule`) and guest (flexible), compute `endMin = startMin + guest.minBlockMin`, run the allowed-guest / host-bounds / remaining-budget checks, insert with `host_activity_id` set, `revalidatePath("/")` — the general overlap check does not apply to the host's own span (contracts/server-actions.md §3)
- [ ] T058 [US4] Add the Overlap Rule section to `components/forms/add-activity-dialog.tsx` for Strict activities: an "Allow overlap" checkbox revealing "Interruptible Minutes" and an "Allowed Interrupters" multi-select composed from shadcn `checkbox`/`card` listing existing Flexible activities, excluding the activity being created (FR-019, research §11)
- [ ] T059 [P] [US4] Create `components/timeline/host-detail-panel.tsx` showing the host's remaining overlap budget ("Interruptible Capacity: N mins") and the "Schedule Inside" trigger (FR-021)
- [ ] T060 [P] [US4] Create `components/forms/schedule-guest-dialog.tsx` — select one activity from the host's allowed-guest set, enter a start time, submit to `scheduleGuestBlock` via `useActionState`, showing nothing selectable when the guest set is empty (Edge Case)
- [ ] T061 [US4] Render guest blocks layered over their host in `components/timeline/timeline.tsx` with a distinct `guest-overlap` variant in `components/timeline/timeline-block.tsx`, keeping the host's own span visually intact (FR-025, SC-008)
- [ ] T062 [US4] Wire `<HostDetailPanel>` into `app/page.tsx` for strict activities that have an overlap rule, deriving remaining budget from the existing `getDayView` result

**Checkpoint**: All four user stories are independently functional

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T063 [P] Document the local setup in `README.md`: env vars, `pnpm db:migrate`, `pnpm dev`, `pnpm test` (replaces the generic Next.js template README noted in the constitution's Sync Impact Report)
- [ ] T064 Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` across the finished feature and fix anything they surface (Constitution Increment Checklist)
- [ ] T065 Run `pnpm test` and confirm `tests/unit/rules.test.ts`, `tests/unit/accounting.test.ts`, and `tests/unit/time.test.ts` all pass with the coverage quickstart.md specifies
- [ ] T066 Execute the full manual validation in [quickstart.md](./quickstart.md) — all four stories including every negative case — and check off its "Done / acceptance" list
- [ ] T067 Simplicity review per Constitution V across `lib/domain/`, `lib/db/`, and `components/`: no generic rule engine crept in, no abstraction without three call sites, no speculative Recurrence structure
- [ ] T068 Verify SC-008 (activities, transitions, and guest blocks are visually distinguishable without explanation) and SC-009 (the create-host → assign-guest → schedule-guest flow completes in under 2 minutes)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **User Story 1 (Phase 3)**: Depends on Foundational only
- **User Story 2 (Phase 4)**: Depends on Foundational; extends US1's activity-creation path
- **User Story 3 (Phase 5)**: Depends on Foundational; independent of US2
- **User Story 4 (Phase 6)**: Depends on Foundational; needs at least one Flexible activity to exist as a guest, so US3 is a practical prerequisite for its full flow
- **Polish (Phase 7)**: Depends on all desired stories being complete

### User Story Dependencies

- **US1 (P1)**: No story dependencies — the MVP
- **US2 (P2)**: Independently testable, but shares `createActivity` and the Add Activity dialog with US1 — those files must exist first
- **US3 (P3)**: Independently testable; shares only the timeline shell with US1
- **US4 (P4)**: Independently testable in isolation, but its allowed guests are Flexible activities from US3 — build after US3 for the end-to-end flow

### Sequential-file Notes (why some tasks are not [P])

- `lib/db/queries.ts` is touched by T015, T016, T025, T026, T033–T035, T048–T050 — always sequential within a phase
- `app/actions.ts` is touched by T020, T030, T041, T042, T056, T057 — always sequential
- `components/forms/add-activity-dialog.tsx` grows across T023, T031, T043, T058 — one story at a time
- `tests/unit/rules.test.ts` is extended by T014, T019, T029, T038, T053 — never in parallel with itself

### Parallel Opportunities

- **Setup**: T003 and T004 run together
- **Foundational**: T005, T006, T007, T008 all run together (four different files); T010 and T012 can follow in parallel
- **US1**: T017 (validation) ‖ T018 (rules) ‖ T021 (timeline-block) — three different files
- **US2**: T027 (validation) ‖ T028 (rules)
- **US3**: T036 (validation) ‖ T037 (rules) ‖ T039 (accounting); later T044 (sidebar) ‖ T045 (dialog)
- **US4**: T051 ‖ T052 ‖ T054; later T059 (detail panel) ‖ T060 (guest dialog)
- Across teams: once Phase 2 is done, US1 and US3 can proceed in parallel by different developers

---

## Parallel Example: Foundational Phase

```bash
# Four independent files — launch together:
Task: "Implement lib/time.ts minutes-from-midnight helpers"
Task: "Define domain types in lib/domain/types.ts"
Task: "Write lib/db/migrations/0001_init.sql"
Task: "Create lib/db/client.ts single libSQL client"
```

## Parallel Example: User Story 3

```bash
# Three independent modules within US3:
Task: "Extend lib/domain/validation.ts with the flexible schema"
Task: "Add evaluatePlacement + checkNoOverlap to lib/domain/rules.ts"
Task: "Create lib/domain/accounting.ts with activityProgressMin"

# Then the two UI surfaces:
Task: "Create components/timeline/flexible-sidebar.tsx"
Task: "Create components/forms/schedule-flexible-dialog.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup (T001–T004)
2. Phase 2: Foundational (T005–T014) — **CRITICAL, blocks everything**
3. Phase 3: User Story 1 (T015–T024)
4. **STOP and VALIDATE**: run quickstart.md "Story 1" including the negative End ≤ Start case
5. Demo — a persisted, visible daily record is already real value

### Incremental Delivery

1. Setup + Foundational → schema applies, pure primitives tested
2. + US1 → timeline + Strict activities (**MVP**) → validate → commit
3. + US2 → transitions → validate → commit
4. + US3 → flexible activities, sidebar, Hard/Soft enforcement → validate → commit
5. + US4 → Overlap Rule, guest blocks, count-once accounting → validate → commit
6. Polish (T063–T068)

### Risk-First Note

FR-026 / SC-007 (overlapping minutes counted once) is the spec's explicitly flagged complexity
risk. T054 and T055 prove it in a pure, DB-free test before any overlap UI is built — if the union
measure is wrong there, no amount of rendering work will hide it.

---

## Notes

- [P] tasks = different files, no dependency on an incomplete task
- [Story] label maps each task to a spec user story for traceability
- Each task is one increment: implement → test → verify → commit, leaving the build green
  (Constitution VI and the Increment Checklist in `.specify/memory/constitution.md`)
- Do not bundle unrelated changes or out-of-scope cleanups into a task (Constitution VII)
- Rule verdicts are **returned, never thrown**; Hard rejects without any write, Soft persists and
  warns — an action must never return `ok: false` for a Soft violation
- Time is integer minutes-from-midnight everywhere; all conversion and comparison goes through
  `lib/time.ts` (Constitution II)
- All database access goes through `lib/db/queries.ts` over the single `lib/db/client.ts`
  (Constitution III) — no ad-hoc connections, no SQL elsewhere
- Recurrence is **documented but not built** this feature (data-model.md "Deferred: Recurrence") —
  do not create a `recurrence_rule` table
- Before touching a Next.js 16.2 API, verify it against `node_modules/next/dist/docs/` per
  `AGENTS.md`
