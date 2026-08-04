# Phase 1 Data Model: Manual Activity Scheduling & Timeline

All time-of-day fields are **integer minutes from midnight** (0–1439). Durations are integer
minutes. IDs are text UUIDs. Booleans are SQLite integers (0/1). Dates are `YYYY-MM-DD` text
(local calendar date). Design rationale for every choice here is in
[research.md](./research.md) — §1 (rules as per-category tables), §2 (strict times _are_ a rule),
§3 (one block table), §4 (accounting), §7 (Recurrence deferred).

## The rules model in storage

An **activity** is a global definition. Its constraints are **rules**, and each rule **category**
gets its own table **primary-keyed by `activity_id`**. That primary key is what enforces the
spec's "an activity holds at most one rule per category" — it is a database invariant, not an
application check.

| Rule trait (spec)                                  | How it is represented                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scope** (system-wide vs activity-level)          | Activity-level rules key on `activity_id`. The Overlap Rule is system-wide — the system always understands it; `overlap_rule` stores a _host's settings_ for it, not the rule's existence.                    |
| **Category** (mutually exclusive, ≤1 per activity) | One table per category; `PRIMARY KEY (activity_id)` makes a second rule in the same category impossible to insert.                                                                                            |
| **Classification** (Hard vs Soft)                  | **Derived in code, never stored**: `temporal_placement_rule.kind='strict'` ⇒ Hard, `'preferred'` ⇒ Soft; all Overlap Rule checks are Hard. Storing it would permit a row claiming a Preferred Window is Hard. |

## Entity overview

```text
Activity 1───1 TemporalPlacementRule     (REQUIRED — category: Temporal Placement)
Activity 1───0..1 OverlapRule            (category: Overlap; hosts only, strict activities only)
OverlapRule 1───* OverlapAllowedGuest ───* Activity   (the allowed-guest set)
Activity 1───0..2 Transition             (one pre, one post)
Activity 1───* ScheduledBlock            (placed instances)
ScheduledBlock 0..1───* Activity(host)   (non-null host_activity_id ⇒ this is a guest block)

Recurrence category: DEFERRED — see "Deferred: Recurrence" below.
```

---

## 1. Activity

A reusable global definition (FR-006). `constraint_type` is `'strict'` or `'flexible'`.

Note what is **not** here: no `start_min`/`end_min` (they are the Temporal Placement rule, §2 of
research) and no `is_container` flag (it is the Overlap Rule's presence).

| Field              | Type          | Notes / Rules                                                                                  |
| ------------------ | ------------- | ---------------------------------------------------------------------------------------------- |
| `id`               | TEXT PK       | UUID                                                                                           |
| `name`             | TEXT NOT NULL | required (FR-004)                                                                              |
| `constraint_type`  | TEXT NOT NULL | `'strict'` \| `'flexible'` (FR-004)                                                            |
| `daily_target_min` | INTEGER NULL  | flexible only; required when flexible (FR-012)                                                 |
| `min_block_min`    | INTEGER NULL  | flexible only; required when flexible (FR-012); also sets a guest block's duration (FR-022)    |
| `created_date`     | TEXT NOT NULL | `YYYY-MM-DD`; the day this definition belongs to (interim stand-in for Recurrence — see below) |

**Validation rules**

- Flexible ⇒ `daily_target_min` and `min_block_min` present and `> 0`.
- Strict ⇒ both NULL (a strict block's duration is its whole window).
- Every activity MUST have exactly one `temporal_placement_rule` row (FR-013 "never neither").
- Only a `'strict'` activity may have an `overlap_rule` row (spec Assumption: Flexible activities
  cannot be hosts in this feature).

**State**: none — create + view only this feature (no edit/delete).

## 2. TemporalPlacementRule _(category: Temporal Placement — required)_

The exclusive Preferred-vs-Strict Window choice (FR-013). One row per activity, always present.

`temporal_placement_rule`

| Field         | Type                           | Notes / Rules                                        |
| ------------- | ------------------------------ | ---------------------------------------------------- |
| `activity_id` | TEXT **PK**, FK → Activity(id) | PK ⇒ at most one rule in this category               |
| `kind`        | TEXT NOT NULL                  | `'preferred'` (Soft) \| `'strict'` (Hard)            |
| `start_min`   | INTEGER NOT NULL               | window start                                         |
| `end_min`     | INTEGER NOT NULL               | MUST be `> start_min` (FR-005 for strict activities) |

**How the window is consumed differs by constraint type** (research §2):

| Activity type | `kind`                      | Meaning                                                                                                                                                                                |
| ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict        | always `'strict'`           | The activity's block **fills the entire window**; `start_min`/`end_min` are its exact fixed times (Story 1).                                                                           |
| Flexible      | `'preferred'` or `'strict'` | Blocks are `min_block_min` long and **float inside** the window. `'strict'` ⇒ a block outside is rejected; `'preferred'` ⇒ a block outside is persisted and flagged (FR-016 / FR-017). |

**Rules**

- `end_min > start_min` — rejected otherwise (FR-005, Edge Case).
- A Strict activity's row MUST have `kind='strict'`; `'preferred'` is meaningless for an activity
  whose times are fixed.
- Classification is derived: `kind='strict'` ⇒ **Hard**, `kind='preferred'` ⇒ **Soft**.

## 3. OverlapRule (host settings) _(category: Overlap — optional)_

The system-wide Overlap Rule as instantiated on a **host** (FR-019, FR-020). Its presence is what
makes an activity a host — this replaces the old `is_container` boolean.

`overlap_rule`

| Field              | Type                           | Notes / Rules                                             |
| ------------------ | ------------------------------ | --------------------------------------------------------- |
| `host_activity_id` | TEXT **PK**, FK → Activity(id) | the host; PK ⇒ at most one Overlap rule per activity      |
| `budget_min`       | INTEGER NOT NULL               | total overlap budget in minutes ("Interruptible Minutes") |

`overlap_allowed_guest` (the allowed-guest set)

| Field               | Type                            | Notes / Rules                    |
| ------------------- | ------------------------------- | -------------------------------- |
| `host_activity_id`  | TEXT NOT NULL FK → Activity(id) | the host                         |
| `guest_activity_id` | TEXT NOT NULL FK → Activity(id) | an allowed **flexible** activity |

**Rules**

- `PRIMARY KEY (host_activity_id, guest_activity_id)` — no duplicate guests.
- The host activity MUST be `constraint_type='strict'` (spec Assumption).
- Guests are chosen only from existing **flexible** activities (spec Assumption).
- `guest_activity_id <> host_activity_id` — no self-overlap (spec Edge Case), enforced by a CHECK
  constraint as well as in the action.
- An **empty** allowed-guest set is valid: the host saves with a budget and zero guests, and no
  guest can yet be scheduled over it (spec Edge Case).
- **Remaining overlap budget** is **derived, never stored** (FR-021, FR-024):
  `budget_min − Σ (end_min − start_min)` over `scheduled_block` rows with this
  `host_activity_id` on the date.
- All Overlap Rule checks are classified **Hard** — a violation rejects the write (FR-023).

## 4. Transition

A named pre- or post-block linked to exactly one parent Activity (FR-009, FR-010).

| Field         | Type                            | Notes / Rules         |
| ------------- | ------------------------------- | --------------------- |
| `id`          | TEXT PK                         | UUID                  |
| `activity_id` | TEXT NOT NULL FK → Activity(id) | parent                |
| `position`    | TEXT NOT NULL                   | `'pre'` \| `'post'`   |
| `name`        | TEXT NOT NULL                   | required              |
| `start_min`   | INTEGER NOT NULL                | required              |
| `end_min`     | INTEGER NOT NULL                | MUST be `> start_min` |

**Rules**

- `end_min > start_min` (Edge Case — reject the save).
- At most one `'pre'` and one `'post'` per parent: `UNIQUE (activity_id, position)`.
- **No adjacency enforcement** to the parent — a gap is allowed and the transition renders at its
  own recorded times (spec Edge Case).

## 5. ScheduledBlock

A manually placed occurrence of a **Flexible** activity on the day's timeline. A row with a
non-null `host_activity_id` **is** the spec's _Overlapping Guest Block_ — the same shape, one
table (research §3).

| Field              | Type                            | Notes / Rules                                                             |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------- |
| `id`               | TEXT PK                         | UUID                                                                      |
| `activity_id`      | TEXT NOT NULL FK → Activity(id) | MUST reference a flexible activity                                        |
| `date`             | TEXT NOT NULL                   | `YYYY-MM-DD` (current date)                                               |
| `start_min`        | INTEGER NOT NULL                | user-supplied start                                                       |
| `end_min`          | INTEGER NOT NULL                | computed = `start_min + activity.min_block_min` (FR-015)                  |
| `host_activity_id` | TEXT NULL FK → Activity(id)     | NULL ⇒ standalone block; non-NULL ⇒ **guest block** overlapping that host |

### 5a. Standalone block (`host_activity_id IS NULL`) — FR-015–FR-018

- Evaluated against the activity's Temporal Placement rule:
  - `kind='strict'` and block outside the window ⇒ **Hard** violation ⇒ **rejected** (FR-016).
  - `kind='preferred'` and block outside the window ⇒ **Soft** violation ⇒ **persisted**, and
    surfaced to the user as a preference violation (FR-017, SC-004).
- MUST NOT overlap any existing block on the timeline for `date` — strict activity spans,
  transitions, and other scheduled blocks. Overlap = ranges intersect with positive length. This
  is a **Hard** check (FR-016).

### 5b. Guest block (`host_activity_id` non-NULL) — FR-022–FR-024

All three checks are **Hard**; any failure rejects without persisting (FR-023):

- `activity_id` MUST appear in the host's `overlap_allowed_guest` set.
- `[start_min, end_min]` MUST fall entirely within the host's window bounds — reject if the
  guest's `min_block_min` would extend past the host's end (spec Edge Case).
- `end_min − start_min` MUST NOT exceed the host's **remaining** overlap budget.
- The block is permitted to intersect **its own host's span only**; that is the sanctioned-overlap
  exemption to 5a's general overlap check.

## Deferred: Recurrence _(category — documented, not built)_

The spec's Rules Model defines a third category whose exclusive options are **Recurring**
(allowed-days set, re-evaluated each matching day, participates in carry-over) and **One-Time**
(bound to a single date, exempt from carry-over). The spec's Assumptions place it — with the
generator and all multi-day behaviour — **out of scope for this feature**, so **no
`recurrence_rule` table is created** (Constitution V; research §7).

Interim behaviour: `activity.created_date` records the day a definition belongs to, and the
current-date-only timeline filters on it — effectively every activity behaves as One-Time-today.

Migration path when Recurrence lands: add `recurrence_rule(activity_id PK, kind, …)` following the
same one-table-per-category pattern, add the union member, and replace the `created_date` filter
with a date-match / allowed-days-match. Purely additive; no existing column changes meaning.

---

## Time accounting (FR-026 / SC-007)

Three distinct quantities, deliberately never conflated (research §4, implemented in
`lib/domain/accounting.ts`):

| Quantity                                       | Definition                                                                  | Guest block's effect                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Activity progress** (sidebar, FR-014/FR-018) | Σ of that activity's own `scheduled_block` durations for the date           | Counts toward the **guest** activity's progress; contributes **nothing** to the host     |
| **Host logged duration** (FR-026, SC-007)      | The host's own span, `end_min − start_min` from its Temporal Placement rule | **Unchanged** — guests never add minutes to it                                           |
| **Total logged time for the day**              | **Union measure** of all block intervals, _not_ their sum                   | Overlapping minutes collapse: 10:00–18:00 host + 13:00–13:30 guest = **8h**, never 8h30m |

Over-target progress is allowed and simply displayed (spec Edge Case) — no cap this feature.

## Referential integrity & indexing

- All FKs declared `ON DELETE CASCADE` (defensive; no delete flow ships this feature).
- `CHECK (guest_activity_id <> host_activity_id)` on `overlap_allowed_guest` (no self-overlap).
- `UNIQUE (activity_id, position)` on `transition`.
- Indexes: `activity(created_date)`, `scheduled_block(date, activity_id)`,
  `scheduled_block(date, host_activity_id)`, `transition(activity_id)` — enough for the per-day
  timeline read, sidebar progress, and remaining-budget derivation.

## Domain types (TypeScript, `lib/domain/types.ts`)

Discriminated unions keep both the constraint type and the rule variant compiler-checked
(Constitution IV) — adding a rule variant later becomes a compile error at every `switch`, not a
silent fallthrough:

```ts
type PreferredWindow = { kind: "preferred"; startMin: number; endMin: number } // Soft
type StrictWindow = { kind: "strict"; startMin: number; endMin: number } // Hard
type TemporalPlacementRule = PreferredWindow | StrictWindow

type OverlapRule = {
  hostActivityId: string
  budgetMin: number
  allowedGuestIds: string[]
}

type StrictActivity = {
  id: string
  name: string
  constraintType: "strict"
  placement: StrictWindow // block fills the whole window
  overlap: OverlapRule | null // present ⇒ this activity is a host
  createdDate: string
}

type FlexibleActivity = {
  id: string
  name: string
  constraintType: "flexible"
  dailyTargetMin: number
  minBlockMin: number
  placement: TemporalPlacementRule // blocks float inside the window
  createdDate: string
}

type Activity = StrictActivity | FlexibleActivity

type ScheduledBlock = {
  id: string
  activityId: string
  date: string
  startMin: number
  endMin: number
  hostActivityId: string | null // non-null ⇒ guest block overlapping that host
}
```

`Transition` is a plain typed record. Raw DB row shapes live in `lib/db/schema.ts` and are mapped
to these domain types at the data-layer boundary — no raw row and no `any` reaches the UI.
