# Phase 0 Research: Manual Activity Scheduling & Timeline

All Technical Context items were resolvable from the project constitution, `AGENTS.md`, the
installed dependency set, the PRD's Rules Model, and the Next.js 16.2 docs bundled in
`node_modules/next/dist/docs/`. No `NEEDS CLARIFICATION` markers remained. Findings below record
the decisions that shape Phase 1.

The dominant open question for this feature was **how literally to implement "rules"** — the spec
pivoted from ad-hoc flags to a rules model, and a naive reading points straight at a generic rule
engine that Constitution V explicitly prohibits. §1 resolves that tension; everything else
follows from it.

---

## 1. How to model rules (scope / category / classification)

- **Decision**: Model each **rule category as its own concrete table keyed by `activity_id`**,
  not as a generic `rule(type, payload_json)` table.
  - `temporal_placement_rule(activity_id PK, kind, start_min, end_min)` — the Temporal Placement
    category, whose `kind` (`'preferred'` | `'strict'`) selects the variant.
  - `overlap_rule(host_activity_id PK, budget_min)` + `overlap_allowed_guest(host_id, guest_id)`
    — the Overlap category, instantiated on a host.
  - Recurrence: **documented, not built** (see §7).

  The three defining traits of a rule map onto structure rather than data:
  - **Scope** → *where the table is keyed*. Activity-level rules key on the activity; the
    system-wide Overlap Rule has no per-activity switch to turn it on globally — it is one rule
    the system always understands, whose per-host *settings* live in `overlap_rule`.
  - **Category** → *one table per category, primary-keyed by activity id*. This makes "an
    activity holds at most one rule per category" (spec Rules Model) a **database-enforced
    invariant**, not something application code must remember to check.
  - **Classification** → *a property of the variant, derived in code*: `kind='strict'` ⇒ Hard,
    `kind='preferred'` ⇒ Soft; the Overlap Rule's bounds/budget/allowed-set checks are Hard. It
    is never stored, because storing it would allow a row asserting a Preferred Window is Hard.

- **Rationale**: This delivers exactly what the spec's Rules Model asks for — typed rules,
  mutually-exclusive categories, Hard/Soft classification driving validation — while satisfying
  Constitution V, which names "configurable rule engines" and "generic activity framework layers"
  as the anti-pattern to avoid. It also satisfies Constitution IV far better than a JSON payload:
  each rule is a typed row mapping to a discriminated union, so `switch (rule.kind)` is
  exhaustiveness-checked and a future variant becomes a compile error rather than a runtime
  surprise.

- **Alternatives considered**:
  - *Generic `rule` table with a JSON payload and a `category` column.* Rejected: prohibited by
    Constitution V, defeats Constitution IV's typed-boundary requirement (payload is `unknown`
    until hand-parsed), and enforces category exclusivity only via a unique index that no type
    system can see. It would be justified only if rules were **user-authored at runtime**, which
    the PRD never asks for — rule *types* are fixed by the developer; users only choose among
    them.
  - *Keep ad-hoc columns on `activity` (`pref_window_start_min`, `is_container`, …), i.e. the
    pre-pivot design.* Rejected: this is precisely what the spec pivoted away from. It cannot
    structurally prevent an activity from holding both a preferred and a strict window (FR-013),
    and it leaves `is_container` as a boolean flag rather than the instance of a system-wide rule.

- **Consequence for the solver (later feature)**: the solver consumes rule *classification*, so
  it can iterate categories generically (`hard rules → skeleton`, `soft rules → relaxation
  cascade`) while each category stays concretely typed. Adding a category later = one table + one
  union member + one case in the cascade; no engine to generalize.

## 2. Strict activities: separate columns vs. a Strict Window rule

- **Decision**: A Strict activity's fixed start/end **is** its Temporal Placement rule
  (`kind='strict'`), stored in the same rule table as a Flexible activity's window. No
  `start_min`/`end_min` columns on `activity`. What differs by constraint type is how the window
  is *consumed*: a **Strict activity's block fills its entire window**, whereas a **Flexible
  activity's block is `min_block_min` long and floats inside it**.

- **Rationale**: The spec (Story 1) already describes a Strict activity as "an activity whose
  Temporal Placement is a **Strict Window** at fixed exact times." Storing that in one place means
  one window-checking function serves both constraint types and there is no second source of
  truth for "when is this activity." It also makes FR-013's "never neither" trivially enforceable:
  every activity has exactly one `temporal_placement_rule` row, NOT NULL by construction.

- **Alternatives considered**: Keeping `activity.start_min`/`end_min` for strict and a rule row
  only for flexible. Rejected — two representations of the same concept, two code paths for
  "where does this activity go", and the compiler cannot tell you which to read.

## 3. Overlap Rule: modeling the host/guest relationship and its blocks

- **Decision**: Guest blocks are **not a separate entity**. There is one `scheduled_block` table;
  a guest block is simply a row whose `host_activity_id` is non-null. Standalone Flexible blocks
  have `host_activity_id IS NULL`.
  - Remaining overlap budget for host H = `overlap_rule.budget_min` − Σ durations of blocks with
    `host_activity_id = H` on that date (derived, never stored).
  - The general "must not overlap an existing block" check (FR-016) treats a non-null
    `host_activity_id` as the **sanctioned-overlap exemption**: a guest block is allowed to
    intersect its own host's span, and nothing else.

- **Rationale**: The spec requires (FR-026) that a guest's minutes count toward *the guest
  activity's own daily progress*. With one table, progress is a single sum over
  `scheduled_block WHERE activity_id = ?` and that requirement is satisfied by construction — a
  separate `guest_block` table would force every progress query to union two tables and would
  make it easy to forget one. It also collapses two spec entities into one storage shape without
  losing any distinction, since `host_activity_id` carries it (Constitution V).

- **Alternatives considered**:
  - *Separate `overlap_guest_block` table* (the pre-pivot `nested_block`). Rejected as above:
    duplicate shape, unioned queries, easy accounting bug.
  - *Shrinking/splitting the host block to carve out the guest.* Rejected — it contradicts the
    spec's "parallel reality" framing and FR-025/SC-007 (the host must still report its full
    span). Splitting would also destroy the host's identity as a single block.

## 4. Overlap-aware time accounting (FR-026 / SC-007)

- **Decision**: A dedicated pure module `lib/domain/accounting.ts` owns every duration figure the
  UI shows, with three distinct notions kept deliberately separate:
  1. **Activity progress** (sidebar) = Σ of that activity's own block durations. A guest block
     counts here for the *guest*, and contributes nothing to the host.
  2. **Host logged duration** = the host's own span, *by definition* — computed from its window
     and never adjusted by guests.
  3. **Total logged time for the day** = the **union measure** of all block intervals, not their
     sum. Overlapping wall-clock minutes collapse, so 10:00–18:00 host + 13:00–13:30 guest = 8h
     of covered clock, never 8h30m.

- **Rationale**: FR-026 and SC-007 are the spec's explicitly flagged complexity risk ("the system
  MUST track actual time spent vs. scheduled time so a 30-minute lunch overlapping an 8-hour
  workday does not count as 8h30m"). A naive `sum(durations)` anywhere in the UI silently breaks
  it, and it is the kind of bug Constitution II calls non-negotiable. Isolating the three
  definitions in one tested module makes the guarantee checkable (`unionMinutes` has a direct
  test) instead of an invariant scattered across render code.

- **Alternatives considered**: Computing totals inline in the sidebar/detail components
  (rejected — the guarantee would live in three places and be untestable without rendering);
  storing a denormalized `logged_min` per activity (rejected — derived data that can drift, and
  Constitution III wants Turso holding facts, not caches).

## 5. Hard vs. Soft enforcement in the Server Action boundary

- **Decision**: Rule evaluation returns a **verdict**, not a boolean:
  `{ ok: true } | { ok: false; classification: 'hard' | 'soft'; message: string }`. The Server
  Action branches on classification — **Hard ⇒ reject and return an error state without
  persisting; Soft ⇒ persist and return `{ ok: true, warnings: [...] }`**. The timeline
  additionally *derives* the flag at render time (a block outside its activity's Preferred
  Window is badged), so the warning survives past the one action response.

- **Rationale**: FR-016/FR-017 differ *only* in classification, so encoding classification in the
  verdict keeps one evaluation path rather than two parallel validators. Deriving the render-time
  flag rather than persisting a `soft_violation` column avoids storing a fact that is already
  computable and could drift if the activity's window were later edited.

- **Alternatives considered**: Boolean validators plus per-call knowledge of which are hard
  (rejected — the caller has to re-encode the classification the rule already knows); persisting
  a violation flag (rejected — derivable, and drift-prone).

## 6. Data mutation mechanism: Server Actions vs. client-side DB writes

- **Decision**: Next.js **Server Actions** (`app/actions.ts`, `'use server'`) for all writes,
  invoked from client-component dialogs via `useActionState`; the timeline page is a **Server
  Component** reading through the data layer. Each action ends with `revalidatePath("/")`.

- **Rationale**: Constitution III mandates a single typed data-access layer with no ad-hoc
  connections; keeping Turso access server-side guarantees that and keeps credentials off the
  client. Verified against the bundled docs per `AGENTS.md`: `01-app/02-guides/forms.md`
  documents the `'use server'` + `useActionState(prevState, formData)` signature and the
  validation-error-return pattern verbatim, and
  `01-app/03-api-reference/04-functions/revalidatePath.md` states that in Server Functions it
  "updates the UI immediately (if viewing the affected path)" — which is exactly FR-007's "without
  requiring a manual page refresh."

- **Alternatives considered**: The PRD's Phase-1 narrative ("the client executes an insert query
  against Turso"). Rejected for this feature — it forks DB access across client and server in
  violation of Constitution III. Note this does **not** compromise the PRD's client-side *solver*:
  the solver is a pure function over already-loaded state (§1's rule functions), and needs no
  client-side DB write to run.

## 7. Recurrence: modeled but not built

- **Decision**: Do **not** create a `recurrence_rule` table in this feature. Document the category
  and its two variants (Recurring with allowed-days + carry-over, One-Time bound to a date) in
  the data model as a deferred category. In the interim, `activity.created_date` records the day
  a definition belongs to, and the current-date-only timeline query filters on it.

- **Rationale**: The spec introduces Recurrence in the Rules Model but its Assumptions place it —
  along with the generator and all multi-day behaviour — **out of scope for this feature**.
  Building an unused table with allowed-days and carry-over semantics is speculative structure
  (Constitution V) whose correct shape depends on the generator that will consume it.

- **Migration path**: Adding the category later is additive — a new table keyed on `activity_id`,
  a new union member, and swapping the `created_date` filter for a date-match/allowed-days match.
  No existing column changes meaning, so no destructive migration.

## 8. Turso access layer & migrations

- **Decision**: Add `@libsql/client`. One module `lib/db/client.ts` exports a single configured
  libSQL client from `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (the URL may be a local `file:` DB
  for dev). All reads/writes go through typed functions in `lib/db/queries.ts`. Schema lives in
  checked-in `lib/db/migrations/0001_init.sql`, applied by a small `pnpm db:migrate` script.

- **Rationale**: Directly satisfies Constitution III (single access layer, migrations in repo, no
  ad-hoc connections). `@libsql/client` is Turso's official driver and works against both hosted
  Turso and a local SQLite file, which keeps local dev frictionless.

- **Alternatives considered**: An ORM (Drizzle/Prisma). Rejected under Constitution V for a
  six-table single-user schema; hand-written typed queries keep the surface minimal and auditable.
  Worth revisiting only if schema growth makes raw SQL error-prone.

## 9. Input validation

- **Decision**: **Zod** at every Server Action boundary, parsing `FormData` into typed inputs
  (discriminated on `constraintType`, and on the chosen temporal-placement `kind`); on failure
  return a structured error state via `useActionState`. Cross-record rules run **after** Zod
  parsing as the pure functions from §1/§5, before persistence.

- **Rationale**: Constitution IV requires validated typed I/O boundaries and names Zod; the
  Next.js forms guide uses this `safeParse` pattern. Separating field-shape validation (Zod) from
  rule evaluation (pure fns) is what makes the rules testable without a DB — the PRD's designated
  primary seam. Zod's discriminated unions also enforce FR-013's exclusivity *at the input
  boundary*, so an impossible pair (both windows) is rejected before it can reach the DB, which
  in turn enforces it structurally.

- **Alternatives considered**: Manual `FormData.get` + hand-checks (rejected — untyped boundary,
  exactly where Constitution IV says bugs hide); client-only validation (rejected — the spec
  requires *the system* to reject invalid saves, i.e. server-enforced).

## 10. Time representation

- **Decision**: Store every time-of-day as an **integer number of minutes from midnight** (0–1439)
  for the current calendar date; `lib/time.ts` converts to/from `"HH:MM"` and performs all
  comparisons and duration math. Dates are `YYYY-MM-DD` text.

- **Rationale**: Constitution II forbids raw string date math and requires a tested utility;
  integer minutes make window, overlap, budget, and union math trivial numeric operations — which
  matters most for §4's union measure. The spec's scope is explicitly current-date-only, so
  full UTC-instant storage is not needed yet; deferring it avoids speculative complexity
  (Constitution V) while keeping every comparison unambiguous (Constitution II).

- **Alternatives considered**: ISO datetime strings (rejected — invites string math and TZ
  ambiguity); JS `Date` in storage (rejected — SQLite has no date type and it reintroduces TZ
  handling this scope does not need). When overnight/multi-date arrives (PRD user stories 44–46),
  migrate to stored UTC instants behind the same utility — callers keep the same function names.

## 11. UI primitives to add (shadcn/ui)

- **Decision**: Compose all UI from `components/ui`, adding the needed primitives via the shadcn
  CLI: `dialog select input label checkbox card badge` (`button` is already present). Feature
  composition lives in `components/timeline/` and `components/forms/`.

- **Rationale**: Constitution I requires shadcn primitives added via the CLI before any custom
  component. The Add Activity form needs a dialog, text/number/time inputs, labels, a
  constraint-type select, a temporal-placement radio/select, checkboxes (transitions, Overlap
  Rule), and a multi-select for allowed guests; the timeline/sidebar need card/badge for blocks,
  progress, and the Soft-violation flag.

- **Note**: The allowed-guest multi-select and the sidebar layout are **not** single shadcn
  primitives — they are *composed* from `checkbox`/`select`/`card` under Constitution I's
  "customization through composition" clause, never forked from a primitive's internals.

- **Alternatives considered**: Hand-built modal/multi-select (rejected — Constitution I; loses
  accessibility the library already provides). Native `<select multiple>` (rejected for theming
  consistency, though native `<input type="time">` *is* used inside a shadcn-styled field, since
  it is a form control shadcn does not replace).

## 12. Timeline rendering model

- **Decision**: The timeline is a **single ordered list of blocks** for the current day, computed
  server-side by merging: strict activities' blocks (from their Strict Window rule), transitions,
  standalone flexible blocks, and guest blocks. Ordering is by start-minute. Guest blocks render
  **layered over** their host's block (parallel reality), visually distinct from the host's
  uncovered time; Soft-violating blocks carry a warning badge.

- **Rationale**: Matches the spec's acceptance scenarios (chronological adjacency for
  transitions; FR-025's overlay for guests) with minimal structure. No FR or SC requires a
  pixel-accurate time grid — only "positioned from start to end" and "visually distinguishable"
  (SC-008) — so a proportional layout suffices without over-engineering (Constitution V).

- **Alternatives considered**: A full pixel-per-minute grid canvas (deferred — not required by any
  FR/SC here; better justified once Focus Mode and drag interactions arrive). Rendering guests as
  *nested children* of the host (rejected — that is the hierarchy framing the spec explicitly
  pivoted away from; overlay preserves the host's own span visually as well as in data).

---

## Summary of resolved unknowns

| Technical Context item | Resolution |
|------------------------|------------|
| Rules model → storage | One concrete table per rule category, PK'd on `activity_id`; category exclusivity is a DB invariant; Hard/Soft derived in code (§1) |
| Strict activity times | Are its Strict Window rule; no duplicate columns on `activity` (§2) |
| Guest/overlap blocks | One `scheduled_block` table; guest = non-null `host_activity_id` (§3) |
| Overlap accounting | Dedicated pure `accounting.ts`; union measure for day totals, count-once guaranteed (§4) |
| Hard vs Soft handling | Rule verdict carries classification; Hard rejects, Soft persists + warns (§5) |
| Mutation mechanism | Server Actions + `revalidatePath("/")`; Server Component reads (§6) |
| Recurrence category | Documented, not built this feature; additive migration path (§7) |
| Storage driver | `@libsql/client` (Turso), single `lib/db` layer, SQL migrations in repo (§8) |
| Validation library | Zod discriminated unions at action boundaries + pure rule functions (§9) |
| Time model | Integer minutes-from-midnight via `lib/time.ts` (§10) |
| UI primitives | shadcn `dialog/select/input/label/checkbox/card/badge` + existing `button` (§11) |
| Timeline layout | Ordered block list; guests layered over hosts; soft violations badged (§12) |
| Testing framework | Vitest for `rules`/`accounting`/`time`; manual quickstart for UI (§4, §5) |
