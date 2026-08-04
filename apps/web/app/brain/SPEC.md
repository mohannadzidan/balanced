# Dynamic Day Scheduler — Engine Specification

**Version 2.0 · Self-contained · Pure engine · Algorithm & interfaces only**

This document describes a scheduling engine in full. A reader with no prior context should be able to implement it from this document alone. It deliberately contains no source code — only data shapes, semantics, algorithms, and contracts.

**Scope boundary.** This specifies a _library_: a set of pure functions and the data types they exchange. It says nothing about storage, transport, processes, or user interfaces, because the engine knows nothing about them. Its entire contact with the outside world is one function call in and one value out. The only executable described here is a terminal harness (Section 13) used to exercise the library by hand, and a unit test suite (Section 16) used to exercise it automatically.

---

## Table of Contents

1. [What this system is](#1-what-this-system-is)
2. [Glossary](#2-glossary)
3. [Time model](#3-time-model)
4. [Domain model](#4-domain-model)
5. [Rule reference](#5-rule-reference)
6. [Lifecycle and states](#6-lifecycle-and-states)
7. [Cost model](#7-cost-model)
8. [The solver](#8-the-solver)
9. [Event flows](#9-event-flows)
10. [Validation and rejection catalogue](#10-validation-and-rejection-catalogue)
11. [Edge cases](#11-edge-cases)
12. [Engine API contract](#12-engine-api-contract)
13. [Terminal harness](#13-terminal-harness)
14. [Worked examples](#14-worked-examples)
15. [Out of scope](#15-out-of-scope)
16. [Build order and acceptance](#16-build-order-and-acceptance)

---

## 1. What this system is

### 1.1 The problem

A person has a set of recurring things they do — work, commute, gym, study, reading, chores — each with a duration, a preferred or required time of day, and a relative importance. A static calendar breaks the moment reality diverges: a meeting overruns, a task finishes early, an urgent errand appears. Fixing the rest of the day by hand is tedious, and the person ends up abandoning the plan.

### 1.2 The solution

The user defines **Activity templates** once. Each template carries **rules** describing when it may be placed, how hard that requirement is, whether it can be shortened, whether it may overlap other activities, and what it must be adjacent to.

A **solver** takes those templates and produces a concrete **timeline** for a given day. Whenever reality diverges — an activity finishes early, is extended, or a new task is inserted — the solver regenerates the remainder of the day from scratch. The past is frozen; the future is always freshly optimal.

### 1.3 The four sentences that define the engine

1. **The engine is one pure function.** `solve(input) → result`. No side effects, no clock read internally, no randomness, no ambient state. Identical input yields byte-identical output, always.
2. **Every change is a full re-solve of the remaining day.** There is no incremental patching of the timeline. This makes behaviour predictable and eliminates an entire class of drift bugs.
3. **Time is an argument, never a reading.** `now` is passed in. The engine cannot ask what time it is, which is what makes any moment of any day reproducible in a test.
4. **The result explains itself.** Every compromise the solver makes emits a diagnostic. The caller never has to reverse-engineer why a block moved; it reads the reason off the result.

Everything else — how templates are stored, how a result is displayed, when `solve` is called — belongs to whatever program embeds the engine and is deliberately unspecified here.

### 1.4 What "the best schedule" means

The solver does not have taste. It minimises a **numeric cost function** (Section 7). Every compromise — shortening an activity, splitting it in two, drifting it outside its preferred hours, dropping it entirely — has a defined price. The cheapest legal schedule wins. If you disagree with a schedule the solver produced, the fix is to change a weight, not to change the algorithm.

---

## 2. Glossary

| Term                  | Meaning                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Activity**          | A reusable global template. "Gym", "Work", "Reading". Never appears on a timeline directly.                      |
| **Rule**              | A typed constraint attached to an Activity or to a TimelineActivity.                                             |
| **TimelineActivity**  | A concrete instance of an Activity placed (or attempted) on one specific day. Carries its own copy of the rules. |
| **Timeline**          | The ordered set of TimelineActivities for one day, plus diagnostics.                                             |
| **Day frame**         | The wall-clock window of one scheduling day, with its timezone and true length in minutes.                       |
| **Placement**         | A concrete `(start, end)` assignment for a TimelineActivity.                                                     |
| **Anchor**            | A block the solver may not move: completed, active, fixed, or carried in from yesterday.                         |
| **Host / Guest**      | In an overlap relationship, the host is the containing activity; a guest is nested inside it.                    |
| **Exclusion window**  | A named sub-region of a host during which no guest may be placed.                                                |
| **Relaxation**        | A compromise the solver applies to fit an activity: drift, shrink, chunk, or skip.                               |
| **Free interval**     | A maximal stretch of the day not occupied by any placed top-level block.                                         |
| **Solve**             | One execution of the engine producing a complete timeline.                                                       |
| **Speculative solve** | A solve run to test whether a proposed user action is legal, whose result is discarded on rejection.             |

---

## 3. Time model

### 3.1 Units and resolution

- All internal time arithmetic uses **integer minutes**.
- The engine works in **offsets from the start of the day frame**, not in timestamps. `0` is the first minute of the day.
- **Grid resolution is 5 minutes** (`GRID = 5`). Every duration, window boundary, and placement start must be a multiple of `GRID`. Inputs that are not are rejected at validation time. This makes the search space finite and small (at most 288 candidate starts per day).

### 3.2 Day frame

```
DayFrame {
  date              : local calendar date (YYYY-MM-DD)
  timezone          : IANA zone, e.g. "Europe/Berlin"
  start_instant     : UTC instant of local 00:00 on this date
  length_minutes    : 1440 normally; 1380 on spring-forward; 1500 on fall-back
}
```

Conversion between wall-clock and offset happens **only at the boundary of the engine**. Inside the solver there are only integers.

### 3.3 Daylight saving

- `length_minutes` is computed from the timezone database, never assumed.
- A wall-clock time that **does not exist** (spring-forward gap) maps to the offset of the transition instant.
- A wall-clock time that occurs **twice** (fall-back) maps to its **first** occurrence.
- Rule windows are authored in wall-clock and resolved to offsets per day using the above.

### 3.4 Day boundaries and spanning

- A placement may extend past `length_minutes`. The portion beyond the boundary becomes a **carry-in** on the next day.
- Carry-in blocks are anchors on the following day, occupying `[0, overflow_minutes)`, flagged `spanning_from_previous_day = true`.
- Nothing may be scheduled before a carry-in block ends.

---

## 4. Domain model

### 4.1 Activity (global template)

| Field              | Type            | Notes                                                                                        |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `id`               | string          | stable                                                                                       |
| `name`             | string          |                                                                                              |
| `duration_minutes` | int             | multiple of `GRID`, > 0. The full, uncompromised length.                                     |
| `priority_rank`    | int             | 1 = most important. **Unique** across the catalogue. Maintained by drag-and-drop reordering. |
| `allowed_days`     | set of weekdays | Days this activity may be generated on.                                                      |
| `enabled`          | bool            | Disabled templates are ignored by generation.                                                |
| `rules`            | list of Rule    | See Section 5.                                                                               |
| `color` / `icon`   | display         | Not used by the solver.                                                                      |

**Instances per day is exactly one.** An activity may end up split into several chunks (Section 5.6), but those chunks belong to a single logical instance and share one duration budget.

### 4.2 Rule (discriminated union)

Every rule has `type` and a `source` field that is either `template` or `instance`.

```
Rule = FixedRule
     | StrictWindowRule
     | FlexibleWindowRule
     | MandatoryRule
     | ShrinkRule
     | SequenceRule
     | OverlapRule
```

Compatibility matrix — at most one rule of each type per activity:

|                | Fixed | Strict Win | Flex Win | Mandatory | Shrink | Sequence | Overlap |
| -------------- | ----- | ---------- | -------- | --------- | ------ | -------- | ------- |
| **Fixed**      | —     | ✗          | ✗        | ✓         | ✗      | ✓        | ✓       |
| **Strict Win** | ✗     | —          | ✗        | ✓         | ✓      | ✓        | ✓       |
| **Flex Win**   | ✗     | ✗          | —        | ✓         | ✓      | ✓        | ✓       |
| **Mandatory**  | ✓     | ✓          | ✓        | —         | ✓      | ✓        | ✓       |
| **Shrink**     | ✗     | ✓          | ✓        | ✓         | —      | ✓        | ✓       |
| **Sequence**   | ✓     | ✓          | ✓        | ✓         | ✓      | —        | ✓       |
| **Overlap**    | ✓     | ✓          | ✓        | ✓         | ✓      | ✓        | —       |

Fixed excludes Shrink because a fixed block's duration is defined by its endpoints.

An activity with **no window rule at all** is fully floating: it may be placed anywhere in the day.

### 4.3 TimelineActivity (instance)

| Field                                       | Type                 | Notes                                                                                       |
| ------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `id`                                        | string               | unique per day                                                                              |
| `activity_id`                               | string · nullable    | null for ad-hoc activities                                                                  |
| `date`                                      | date                 |                                                                                             |
| `name`, `duration_minutes`, `priority_rank` | copied at generation |                                                                                             |
| `rules`                                     | list of Rule         | **deep copy** taken at generation; later edits here override the template for this day only |
| `state`                                     | enum                 | See Section 6                                                                               |
| `planned_start`, `planned_end`              | offset               | current solver output                                                                       |
| `actual_start`, `actual_end`                | offset · nullable    | recorded reality                                                                            |
| `scheduled_minutes`                         | int                  | sum across chunks; ≤ `duration_minutes`                                                     |
| `chunk_index`, `chunk_count`                | int                  | 1-based; `chunk_count = 1` when not split                                                   |
| `chunk_group_id`                            | string · nullable    | shared by all chunks of one instance                                                        |
| `host_instance_id`                          | string · nullable    | set when nested as a guest                                                                  |
| `is_adhoc`                                  | bool                 |                                                                                             |
| `spanning_from_previous_day`                | bool                 |                                                                                             |
| `relaxations`                               | list                 | which compromises were applied and by how much                                              |
| `locked`                                    | bool                 | true for anchors                                                                            |

**Templates are never mutated by the solver.** History is immutable: once a day is finalised, its TimelineActivities are frozen forever, even if the template later changes.

### 4.4 Timeline (one day)

```
Timeline {
  day_frame          : DayFrame
  revision           : int              // input revision + 1; purely derived, never read from a clock
  instances          : TimelineActivity[]
  diagnostics        : Diagnostic[]
  cost               : CostBreakdown
  status             : OK | DEGRADED
  solved_at_offset   : int              // the `now` that produced this timeline
}
```

`DEGRADED` means the solve succeeded but at least one hard requirement could not be met (a mandatory activity was skipped, or two fixed blocks conflict). The timeline is still returned — the user must see their day — accompanied by blocking diagnostics.

### 4.5 Structural invariants

These must hold in every timeline the engine emits. Assert them; a violation is a solver bug.

1. Top-level blocks never overlap each other.
2. A guest block lies entirely within its host's placement.
3. Guests of the same host never overlap each other.
4. No guest intersects any exclusion window of its host.
5. Sum of guest durations per host ≤ that host's overlap budget.
6. For every instance: `scheduled_minutes ≤ duration_minutes`, and if scheduled at all, `scheduled_minutes ≥ shrink floor`.
7. Every placement start and end is a multiple of `GRID`.
8. No block starts before the end of the frozen region.
9. Exclusion windows consume no duration and no overlap budget.

---

## 5. Rule reference

### 5.1 FixedRule

```
FixedRule { start_wall, end_wall }
```

The activity occupies exactly this wall-clock range. The solver never moves, shortens, or splits it. Its duration is derived from the endpoints and overrides `duration_minutes`.

- Fixed blocks are placed **first**, before everything else.
- Two fixed blocks that overlap are a configuration error (Section 10).
- `end_wall < start_wall` means the block spans midnight.

### 5.2 StrictWindowRule

```
StrictWindowRule { start_wall, end_wall }
```

The activity must be placed **entirely** inside the window. Zero tolerance.

- If `window_length < duration` and the activity cannot shrink to fit, the activity is unplaceable.
- Validation warning at validation time when `window_length < duration` and no ShrinkRule is present.
- Under chunking, **every chunk** must lie inside the window.

### 5.3 FlexibleWindowRule

```
FlexibleWindowRule { start_wall, end_wall, max_drift_minutes }
```

The window is a preference. The activity may hang out of it, on either side.

**Drift is measured in minutes of the activity that lie outside the window**, summed across both sides — not as displacement of the start time.

Example: window 18:00–20:00, duration 60, `max_drift_minutes = 30`.

| Placement   | Minutes outside | Verdict             |
| ----------- | --------------- | ------------------- |
| 18:00–19:00 | 0               | ideal, zero cost    |
| 17:45–18:45 | 15              | legal, costed       |
| 19:30–20:30 | 30              | legal, at the limit |
| 20:15–21:15 | 60              | **illegal**         |

- Drift costs money (Section 7), so the solver only uses it under pressure.
- Under chunking, drift is summed across all chunks and compared against the single `max_drift_minutes` allowance.
- If `window_length < duration`, drift is unavoidable; minimum unavoidable drift is `duration − window_length`. Validation warns if that exceeds `max_drift_minutes`.

### 5.4 MandatoryRule

```
MandatoryRule { }
```

The activity may not be skipped.

- During **generation**, a mandatory activity that cannot be placed produces status `DEGRADED` plus a blocking diagnostic. Generation never fails outright — the user must always be shown a day.
- During a **user operation** (extend, add ad-hoc, edit rules), an action that would make a mandatory activity unplaceable is **rejected**; state is unchanged.
- Mandatory is orthogonal to priority. A low-priority mandatory activity still gets placed; see the two-pass solver (Section 8.4).

### 5.5 ShrinkRule (shrinking and chunking)

```
ShrinkRule {
  min_duration_minutes   : int              // hard floor for total scheduled time
  chunking_allowed       : bool             // default false
  min_chunk_minutes      : int              // ignored unless chunking_allowed
  max_chunks             : int              // default 3
}
```

Two distinct relaxations live in one rule:

- **Shrink** — schedule less total time than `duration_minutes`, never below `min_duration_minutes`.
- **Chunk** — split the scheduled time across up to `max_chunks` separate blocks, each at least `min_chunk_minutes`.

Rules of combination:

- Chunks may sum to the full duration (chunking without shrinking) or to less (both) — a chunked plan is accepted whenever its total clears `min_duration_minutes`, the same floor a single block must clear. Reaching the full duration is simply the cheapest such total (zero shrink cost), not a requirement: chunking may complete an activity **partially**, splitting whatever scattered free time exists into legal pieces, rather than being all-or-nothing on top of already being split (see 14.6b).
- `min_chunk_minutes ≤ min_duration_minutes ≤ duration_minutes` must hold.
- One unsplit block at full duration is always the zero-cost baseline. Chunking is penalised per extra chunk, so the solver prefers whole blocks and only fragments when the alternative is worse.
- Without a ShrinkRule, an activity is all-or-nothing: full duration in one block, or skipped.

### 5.6 SequenceRule

```
SequenceRule {
  role              : "pre" | "post"
  linked_activity_id: string           // the host
  max_gap_minutes   : int              // default 0
}
```

Attached to the **dependent** activity, pointing at its host. "Commute is a _pre_ of Work" is a SequenceRule on Commute.

Semantics:

- `pre`: `dependent.end ≤ host.start` and `host.start − dependent.end ≤ max_gap_minutes`.
- `post`: `dependent.start ≥ host.end` and `dependent.start − host.end ≤ max_gap_minutes`.
- Gap minutes are costed, so the solver packs them tight by default.
- **The host's placement must leave room for its dependents.** A host placement candidate is infeasible if no legal placement exists for its pre/post partners. Dependents are placed immediately after their host, out of priority order.
- **Dependent skip is free.** If the host is skipped or not scheduled, every dependent is skipped with reason `HOST_SKIPPED` and incurs **zero** skip cost — otherwise the solver would contort the schedule to save a commute to a place it is not going.
- A host may have at most one `pre` and one `post`.
- Chains are allowed (`A pre B`, `B pre C`), cycles are rejected at validation time.
- A chunked host binds its dependents to the **first** chunk (`pre`) and the **last** chunk (`post`).

### 5.7 OverlapRule

```
OverlapRule {
  budget_minutes     : int
  allowed_guest_ids  : string[]          // activity ids, or instance ids for ad-hoc
  exclusion_windows  : ExclusionWindow[]
}

ExclusionWindow {
  id, name           : string
  anchor             : "relative" | "absolute"
  start_offset       : int               // minutes from host start; anchor = relative
  end_offset         : int
  start_wall, end_wall                   // anchor = absolute
}
```

Attached to the **host**. It declares: "this activity may be interrupted, by these specific activities, for this many minutes in total, except during these named windows."

Semantics:

- A guest is **nested**: its block lies entirely inside the host's placement and does not occupy standalone time elsewhere in the day. A nested guest's duration is satisfied by the nesting.
- All guests draw from **one shared budget**. Three guests of 20 minutes exhaust a 60-minute budget.
- A guest must still satisfy its own rules (its own window, its own shrink floor).
- Guests may not overlap each other.
- A guest may not intersect any exclusion window.
- **Exclusion windows consume neither duration nor overlap budget.** They are annotations on the host, not sub-blocks with their own time cost.
- `relative` anchoring moves the exclusion window with the host ("the first hour of work is focus time"). `absolute` anchoring pins it to the wall clock ("the customer call is at 14:00").
- An **absolute-anchored exclusion window is a hard placement constraint on the host**: the host must be placed such that the window falls entirely inside it. Host placements that fail this are infeasible.
- Nesting is evaluated when the guest's turn comes in priority order, against hosts **already placed**. Validation warns at validation time if a guest outranks its host, because the guest's turn would come first and nesting would never be considered.

---

## 6. Lifecycle and states

### 6.1 States

| State        | Meaning                                             | Movable by solver |
| ------------ | --------------------------------------------------- | ----------------- |
| `PLANNED`    | Scheduled, not started                              | yes               |
| `ACTIVE`     | Currently running                                   | no — anchor       |
| `COMPLETED`  | Finished; `actual_start`/`actual_end` recorded      | no — anchor       |
| `SKIPPED`    | Could not be placed today, or dismissed by the user | n/a               |
| `CARRIED_IN` | Spans in from yesterday                             | no — anchor       |

`COMPLETED` carries `completed_source ∈ {user, auto, backdated}` so a caller can distinguish real completions from assumed ones. The solver itself treats all three identically — they are all anchors.

### 6.2 Transitions

```
                 auto at planned_start
      PLANNED ─────────────────────────► ACTIVE
         │                                 │
         │ solver drops it                 │ auto at planned_end
         │ or user dismisses               │ or user "Finish Early"
         ▼                                 ▼
      SKIPPED                          COMPLETED
         ▲                                 ▲
         │                                 │ backdated on late app open
         └─────────────────────────────────┘
```

- **Auto-start**: at `planned_start`, `PLANNED → ACTIVE`, without user action.
- **Auto-complete**: at `planned_end`, `ACTIVE → COMPLETED` with `actual = planned`. The system assumes perfect completion; there is no reality-check prompt.
- **Backdating**: on any solve, every `PLANNED` block entirely before `now` becomes `COMPLETED` with `completed_source = backdated` and `actual = planned`. A block straddling `now` becomes `ACTIVE` with `actual_start = planned_start`.
- Backdating applies to **all** unfinalised past days, not just the current one, using the same rule. A `now` that lands a week after the last solve is therefore an ordinary input, not a special case.

### 6.3 The frozen region

At the start of every solve, the engine computes `freeze_boundary`:

```
freeze_boundary = max(
    now,
    end of the last COMPLETED block,
    end of the ACTIVE block (or its adjusted end for a Finish Early / Extend event),
    end of any CARRIED_IN block
)
```

Everything before `freeze_boundary` is immutable and reproduced verbatim in the output. Everything after it is re-solved from scratch. Fixed blocks after the boundary remain anchors but are re-placed at their declared times.

---

## 7. Cost model

### 7.1 Why a cost model exists

"Best possible schedule" is meaningless until the trade-offs are priced. Is it better to shorten the gym by 15 minutes or to drop reading entirely? To split deep work into two 45-minute blocks or to keep one 90-minute block and drift it an hour late? The cost function answers all such questions in one place.

### 7.2 Priority weight

For an activity with rank `r` in a catalogue of `R` ranked activities:

```
W(a) = R + 1 − r          // rank 1 gets the largest weight
```

Ad-hoc activities are inserted into the ranking at creation time and participate identically.

### 7.3 Cost terms

| Term                    | Formula                | Default constant | Applies when                                  |
| ----------------------- | ---------------------- | ---------------- | --------------------------------------------- |
| **Skip**                | `W(a) × SKIP`          | `SKIP = 10 000`  | activity not scheduled at all                 |
| **Mandatory skip**      | `∞`                    |                  | a MandatoryRule activity is skipped           |
| **Dependent skip**      | `0`                    |                  | skipped because its sequence host was skipped |
| **Unscheduled minute**  | `W(a) × SHRINK × m`    | `SHRINK = 20`    | `m = duration − scheduled_minutes`            |
| **Extra chunk**         | `W(a) × CHUNK × (k−1)` | `CHUNK = 200`    | `k` = number of chunks                        |
| **Drift minute**        | `W(a) × DRIFT × d`     | `DRIFT = 10`     | `d` = minutes outside a flexible window       |
| **Sequence gap minute** | `W(a) × GAP × g`       | `GAP = 5`        | gap between dependent and host                |
| **Idle minute**         | `IDLE × 1`             | `IDLE = 1`       | any minute of the day with no top-level block |

Idle cost is **unweighted and global**. It gently favours dense schedules and breaks ties toward earlier placement, but can never outweigh a real relaxation.

### 7.4 The dominance invariant

Skipping must always be worse than any combination of legal relaxations, or the solver will "solve" a crowded day by discarding work.

```
For every activity a:
    W(a) × SKIP  >  W(a) × SHRINK × (duration − min_duration)
                  + W(a) × CHUNK  × (max_chunks − 1)
                  + W(a) × DRIFT  × max_drift_minutes
                  + W(a) × GAP    × max_gap_minutes
```

Cancelling `W(a)`, this reduces to a check on the constants and the activity's own parameters — no schedule required. **`validateActivity` enforces it** and reports `DOMINANCE_VIOLATION` naming the offending parameter. With the defaults it holds for any activity up to roughly 8 hours with generous relaxation allowances. Give it a dedicated unit test with a deliberately broken activity, because when this invariant fails the symptom is not a crash but a solver that quietly starts throwing away work.

### 7.5 Two levels of cost

- **Placement cost** — the cost of one candidate placement of one activity. Used to choose among candidates during greedy placement. Excludes idle.
- **Schedule cost** — the total for a complete timeline: sum of placement costs, plus idle, plus skip costs. Used to compare whole alternative schedules during backtracking, and returned in `CostBreakdown`. It is also the most useful single assertion in a test: a schedule that costs what you expect is almost always the schedule you expect.

### 7.6 Determinism and tie-breaking

The solver must be perfectly deterministic. When two options have equal cost, break ties in this exact order:

1. Earlier start time.
2. Fewer chunks.
3. Longer scheduled duration.
4. Lexicographically smaller instance id.

---

## 8. The solver

### 8.1 Contract

```
solve(SolveInput) → SolveResult
```

Pure. No I/O, no clock access, no randomness. `now` is an input, not something the function reads. Identical inputs must produce identical outputs — this is what makes the fixture-based test corpus possible.

### 8.2 Inputs

```
SolveInput {
  day_frame     : DayFrame
  now           : int                 // offset into the frame
  catalog       : Activity[]          // templates, already filtered by enabled
  existing      : TimelineActivity[]  // prior instances for this day, may be empty
  carry_in      : TimelineActivity[]  // spanning blocks from yesterday
  event         : Event               // see Section 9
  constants     : CostConstants       // overridable
}
```

### 8.3 Phase 0 — Freeze and seed

1. Resolve the day frame; compute `length_minutes`.
2. Apply backdating (Section 6.2) to `existing`.
3. Compute `freeze_boundary` (Section 6.3).
4. Copy every anchor into the output timeline verbatim. Mark their intervals occupied.
5. Build the **candidate set**: for each enabled template whose `allowed_days` includes this weekday and which has no anchor instance already, create a fresh `TimelineActivity` with a deep copy of the template rules. Preserve any existing instance's rule overrides and ad-hoc instances.
6. Apply the event's mutation to the candidate set (extend a duration, insert an ad-hoc, override a rule).
7. Resolve every rule's wall-clock times to offsets for this frame.

### 8.4 Phase 1 — Hard set placement

The **hard set** is every candidate carrying a `FixedRule`, a `MandatoryRule`, or a `StrictWindowRule`, regardless of priority.

Why a separate pass: a low-priority mandatory activity placed last would routinely find the day already full. Placing all hard requirements before any discretionary ones is what makes "mandatory" mean something.

Procedure:

1. Place all `FixedRule` activities at their declared times. Any overlap between two of them is a hard configuration error.
2. Order the rest of the hard set by **most-constrained-first**: count the feasible placements of each activity against the anchors alone; ascending. Ties break by priority rank.
3. Place each with the single-activity search (Section 8.6).
4. On failure, **backtrack chronologically**: undo the most recent hard-set placement, try its next-best candidate, and continue. Cap the search at `HARD_SET_NODE_LIMIT = 5000` nodes.
5. If the limit is hit or the search exhausts, mark the activity `SKIPPED` with reason `INFEASIBLE_HARD_CONSTRAINT`, emit a blocking diagnostic naming the conflicting activities, and continue with the remainder. Status becomes `DEGRADED`.

### 8.5 Phase 2 — Greedy placement by priority

Process the remaining candidates in ascending `priority_rank`. For each:

1. Run the single-activity search (Section 8.6).
2. Accept the minimum-cost result and mark its intervals occupied.
3. If nothing is feasible, mark `SKIPPED` with a reason.

No backtracking occurs in this phase. By construction, everything already placed is either a hard requirement or more important than the current activity, so displacing it would be strictly worse under the cost model.

**This is where the Nudge → Shrink → Displace hierarchy actually lives.** It is not something a high-priority block does to a low-priority one; it is the ladder each activity climbs for itself, against a day already populated by its betters:

```
        try full duration inside its window          ← "nudge" (move within legal space)
                        │ infeasible
                        ▼
        try full duration with drift                 ← "nudge" beyond the window
                        │ infeasible or costly
                        ▼
        try reduced duration ≥ shrink floor          ← "shrink"
                        │ infeasible or costly
                        ▼
        try splitting into chunks                    ← "shrink" (fragmented)
                        │ infeasible or costly
                        ▼
                     SKIPPED                         ← "displace"
```

The ladder is descriptive, not procedural: the search evaluates all rungs and picks the cheapest, and the cost constants guarantee the ordering above.

### 8.6 Single-activity placement search

Given activity `a` and the set of occupied intervals:

**Step 1 — Free intervals.** Compute `F` = maximal intervals of `[freeze_boundary, length_minutes]` not occupied by any top-level block. Also carry the list of **nestable regions**: for each placed host whose `allowed_guest_ids` contains `a`, the host's span minus its exclusion windows minus its already-placed guests, capped by its remaining budget.

**Step 2 — Candidate enumeration.** For each candidate duration `d`, from `duration_minutes` down to the shrink floor in steps of `GRID` (just `duration_minutes` if there is no ShrinkRule), and for each start offset `s` at every `GRID` multiple inside every free interval and every nestable region:

Emit the candidate `(d, s, nested_in)`. At most 288 starts × (duration range / 5) candidates — a few thousand evaluations, trivially fast.

**Step 3 — Feasibility filter.** Discard the candidate unless all hold:

- `[s, s+d)` fits entirely within one free interval (or one nestable region, if nested).
- `s ≥ freeze_boundary`.
- FixedRule: `s` and `d` match the declared endpoints exactly.
- StrictWindowRule: `[s, s+d)` lies entirely inside the window.
- FlexibleWindowRule: minutes outside the window ≤ `max_drift_minutes`.
- SequenceRule: a legal placement exists for every dependent, given this placement.
- Absolute-anchored exclusion windows of `a` fall entirely inside `[s, s+d)`.
- If nested: budget remaining ≥ `d`; no intersection with exclusion windows or sibling guests.
- `s + d ≤ length_minutes`, unless the activity is permitted to span midnight.

**Step 4 — Cost and selection.** Compute the placement cost of each survivor (Section 7.3, excluding idle). Select the minimum; break ties per Section 7.6.

**Step 5 — Chunked alternative.** If a ShrinkRule permits chunking, additionally evaluate chunk plans:

- For `k` from 2 to `max_chunks`, greedily fill the `k` cheapest-cost regions with segments of at least `min_chunk_minutes`, until `duration_minutes` is met or regions run out.
- A plan whose pieces fall short of `duration_minutes` is still a legal candidate as long as its total reaches at least `min_duration_minutes` — the same floor that governs a single shrunk block (Section 5.5). Only a total below that floor is discarded.
- Every chunk must independently satisfy the window rules; drift sums across chunks.
- Cost the resulting plan (its shortfall from `duration_minutes`, if any, prices as ordinary shrink cost) and compare against the best single-block result. Take the cheaper.

**Step 6 — Dependents.** If the chosen placement has sequence dependents, place them immediately, adjacent, within `max_gap_minutes`, before moving to the next activity.

**Step 7 — Result.** Return the placement plus the list of relaxations applied, or `SKIPPED` with a machine-readable reason:

`NO_FREE_SPACE`, `WINDOW_UNSATISFIABLE`, `DRIFT_EXCEEDED`, `BUDGET_EXHAUSTED`, `HOST_SKIPPED`, `INFEASIBLE_HARD_CONSTRAINT`, `NOT_ALLOWED_TODAY`.

### 8.7 Phase 3 — Finalise

1. Recompute idle minutes and the full `CostBreakdown`.
2. Detect midnight overflow and emit next-day carry-in records.
3. Assert every structural invariant from Section 4.5. A failed assertion is a solver bug and must fail loudly in development.
4. Emit diagnostics: one per relaxation and one per skip, each with a human-readable explanation ("Gym shortened from 60 to 45 minutes because Work ran 40 minutes late").
5. Set `status` to `DEGRADED` if any mandatory activity is unplaced or any hard configuration error was found; otherwise `OK`.

### 8.8 Diagnostics

```
Diagnostic {
  severity        : info | warning | blocking
  code            : machine-readable
  instance_ids    : string[]
  message         : human-readable
  suggested_fix   : string · nullable
}
```

Diagnostics are the engine's only channel for explaining itself. A caller must never re-derive an explanation by comparing two timelines — if a reason is worth showing, the engine emits it here.

---

## 9. Event flows

An **event** is a value passed into `solve` alongside the current state. It is not a message, a request, or a command object with behaviour — it is data describing what changed. Every event travels the same path inside the pure function:

```
SolveInput { state, now, event }
        │
        ▼
  check event preconditions against state ────► REJECTED (state echoed back unchanged)
        │ ok
        ▼
  apply the event's mutation to a *copy* of the candidate set
        │
        ▼
  run the full solve (Sections 8.3 – 8.7)
        │
        ▼
  test the result against the rejection criteria (Section 10.2)
        │                                  │
        │ clean                             │ violated
        ▼                                  ▼
  SolveResult { OK | DEGRADED }      SolveResult { REJECTED, rejection }
```

Two properties follow, and both matter:

- **Rejection is a return value, not an exception.** A rejected solve returns the _original_ timeline together with a `RejectionError`. The caller can render "that would break X" without any rollback logic, because nothing was ever mutated.
- **The speculative solve is the only validation mechanism.** There is no second engine that predicts whether an operation is legal. The engine simply tries it and inspects the outcome, which means validation and execution can never disagree.

### 9.1 `GENERATE_DAY`

**Event data:** none beyond the date in the day frame.
**Precondition:** the input timeline is empty or the caller has explicitly requested regeneration; the date is not finalised.
**Steps:** Phase 0 with `existing = []`, then the full solve.
**Rejection:** none. Generation never fails; it degrades and reports.
**Result:** a complete timeline at `revision = 1`.

### 9.2 `TICK(now)`

**Event data:** none. `TICK` is the null event — it advances the timeline to `now` and nothing else. Every other event implies a tick before its own effect.
**Steps:**

1. Apply auto-start, auto-complete, and backdating (Section 6.2).
2. If any state changed, re-solve the remainder.
3. If nothing changed, return the input timeline unchanged and **do not** increment `revision`.

**Result:** the timeline advances purely as a function of `now`. Calling `TICK` with the same `now` twice is a no-op the second time — the event is idempotent, which is what allows a caller to tick as often as it likes without accumulating churn.

### 9.3 `FINISH_EARLY(instance_id, at)`

**Preconditions:** the instance is `ACTIVE`; `at ≥ actual_start`; `at ≤ planned_end`.
**Steps:**

1. Set `actual_end = at`, state `COMPLETED`, `completed_source = user`.
2. `freeze_boundary = at`.
3. Re-solve everything after the boundary from scratch.

**Rejection:** none — the user is reporting reality, and reality is not negotiable.
**Result:** the freed time is automatically reused. Because the remainder is re-solved from scratch, an activity that was previously shrunk or skipped may now be restored at full duration — this is the intended "use the free time for something useful" behaviour, and it requires no special-case logic. If nothing fits, the gap simply stays idle. **There is no "Free Time" block type**; idle time is the absence of blocks.

### 9.4 `EXTEND(instance_id, minutes)`

**Preconditions:** the instance is `ACTIVE`; `minutes > 0` and a multiple of `GRID`.
**Steps:**

1. Set the instance's planned end to `planned_end + minutes` and freeze it there.
2. Solve the remainder.
3. If any criterion in Section 10.2 is met, return `REJECTED` with the input timeline untouched.
4. Otherwise return the new timeline.

**Result:** subsequent blocks nudge, shrink, or drop per the cost model, each change carrying its own diagnostic.

### 9.5 `ADD_ADHOC(payload)`

**Payload:** name, duration, priority rank (inserted into the ranking), optional rules of any type, and the target date.
**Steps:**

1. Create a TimelineActivity with `is_adhoc = true`, `activity_id = null`. The input catalogue is **not** modified — the engine never writes to `catalog`, which is why the same catalogue value can be reused across every solve in a test.
2. Validate rule compatibility and the dominance invariant.
3. Solve; reject per Section 10.2, otherwise return the new timeline.

**Note:** ad-hoc activities carry the full rule vocabulary — fixed, strict window, mandatory, shrink, sequence, overlap. They are first-class participants in the constraint logic, not a lesser kind of block.

### 9.6 `EDIT_INSTANCE_RULES(instance_id, rules)`

**Purpose:** change a rule for today only, without touching the template. The canonical case is permitting an ad-hoc activity as a guest of today's Work block.
**Steps:**

1. Replace the instance's rule of that type; set `source = instance`.
2. Solve; reject per Section 10.2, otherwise return the new timeline.

**Durability rule:** an override lives on the instance, and the instance is part of the state the caller passes back in on the next solve. Phase 0 must therefore carry `source = instance` rules forward untouched and never re-copy that rule type from the template. This is the single most commonly broken behaviour in this spec and deserves its own test: solve, override, solve, solve again, assert the override survived all three.

### 9.7 `SKIP(instance_id)` and `RESTORE(instance_id)`

Marks a `PLANNED` instance as user-skipped (or lifts that mark) and re-solves. `SKIP` is never rejected. `RESTORE` follows the ad-hoc rejection rules.

### 9.8 `FINALISE_DAY(date)`

**Precondition:** `now ≥ length_minutes`.
**Steps:** backdate any residue, compute the `carry_in` list for the next day frame, and set `finalised = true` on the timeline.
**Result:** a finalised timeline plus its carry-in blocks. The engine refuses every further event against a finalised timeline with `SPANS_FROZEN_REGION`. The returned carry-in list is the sole input linking one day to the next; the engine holds no cross-day state of its own.

---

## 10. Validation and rejection catalogue

### 10.1 Catalogue validation (`validateActivity`, `validateCatalog`)

Pure predicates over a catalogue, independent of any day or solve. They return issue lists; they never throw. Errors — the caller must not proceed:

| Code                   | Condition                                                  |
| ---------------------- | ---------------------------------------------------------- |
| `RULE_INCOMPATIBLE`    | Two mutually exclusive rules on one activity (Section 4.2) |
| `DURATION_NOT_ON_GRID` | A duration or boundary is not a multiple of `GRID`         |
| `SHRINK_FLOOR_INVALID` | `min_duration > duration`, or `min_chunk > min_duration`   |
| `SEQUENCE_CYCLE`       | The sequence graph contains a cycle                        |
| `SEQUENCE_MULTIPLE`    | A host already has a `pre` (or `post`) partner             |
| `PRIORITY_DUPLICATE`   | Two activities share a rank                                |
| `DOMINANCE_VIOLATION`  | The Section 7.4 invariant fails for this activity          |
| `WINDOW_INVERTED`      | `end ≤ start` on a non-spanning window                     |

Warnings — legal, but almost always a mistake worth surfacing:

| Code                  | Condition                                                                    |
| --------------------- | ---------------------------------------------------------------------------- |
| `WINDOW_TOO_SHORT`    | Strict window shorter than duration, no shrink rule                          |
| `DRIFT_UNAVOIDABLE`   | `duration − flexible window length > max_drift`                              |
| `GUEST_OUTRANKS_HOST` | A guest's rank is better than its host's, so nesting will never be evaluated |
| `NO_ALLOWED_DAYS`     | `allowed_days` is empty                                                      |

### 10.2 Event-time rejection

An event-bearing solve returns `REJECTED` — with the input timeline echoed back unchanged — when the speculative solve produces any of:

| Code                     | Condition                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `FIXED_COLLISION`        | Two fixed blocks would overlap                                                             |
| `MANDATORY_UNPLACEABLE`  | A mandatory activity, previously placed, becomes skipped                                   |
| `STRICT_WINDOW_VIOLATED` | A strict-window activity, previously placed, becomes unplaceable                           |
| `GUEST_WINDOW_VIOLATED`  | Moving a host pushes a nested guest outside its own strict window                          |
| `SEQUENCE_UNSATISFIABLE` | A sequence dependent can no longer be placed adjacently and its host is not itself skipped |
| `SPANS_FROZEN_REGION`    | The operation would alter a completed or carried-in block                                  |

```
RejectionError {
  code                    : one of the codes above
  message                 : human-readable
  conflicting_instance_ids: string[]
  diagnostics             : Diagnostic[]     // the blocking diagnostics from the discarded solve
  best_effort_timeline    : Timeline · null  // the rejected result, for "here is what would have happened"
}
```

`best_effort_timeline` is what the discarded speculative solve produced. Returning it costs nothing — it was computed anyway — and it lets a caller show the consequence of an action it is refusing to take.

**Comparison is against the input timeline, not against feasibility in the abstract.** "A mandatory activity becomes skipped" means it was placed before the event and is skipped after. An activity already skipped before the event does not trigger a rejection, because the event did not cause it. Without this rule, a single degraded day would freeze the engine: every subsequent event would be rejected for a violation it did not introduce.

### 10.3 Degradation, not rejection

During `GENERATE_DAY` and `TICK` — where there is no user intent to refuse — the same conditions produce status `DEGRADED` and blocking diagnostics instead of a rejection. **Rule of thumb: events that merely represent the passage of time degrade and explain; events that represent a user's intent fail loudly.** A day must always be producible, even a bad one.

---

## 11. Edge cases

Each of these must have a fixture in the test corpus.

| #   | Case                                              | Specified behaviour                                                                                                                                                                              |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Midnight-spanning activity                        | Placed to the day boundary; the overflow becomes tomorrow's `CARRIED_IN` anchor, locked, labelled "Spanning from yesterday".                                                                     |
| 2   | Finish early on a carry-in block                  | Record `actual_end`; free the remainder; re-solve the new day from that point.                                                                                                                   |
| 3   | `now` several days after the last solve           | Every unfinalised past day is backdated with the same rule; blocks become `COMPLETED` with `completed_source = backdated`. No special case in the code.                                          |
| 4   | Spring-forward day                                | `length_minutes = 1380`. Non-existent wall-clock times resolve to the transition instant. Activities may become unplaceable — that is correct, not a bug.                                        |
| 5   | Fall-back day                                     | `length_minutes = 1500`. Ambiguous times resolve to the first occurrence.                                                                                                                        |
| 6   | Two fixed blocks overlap                          | Generation: `DEGRADED` + blocking diagnostic. User action: `FIXED_COLLISION` rejection.                                                                                                          |
| 7   | Equal-cost placements                             | Resolved by the tie-break chain in Section 7.6. Ranks are unique, so activity-level ties are impossible; chunk-level ties are not.                                                               |
| 8   | Guest with its own strict window                  | Must satisfy both the host's nesting constraints and its own window. Otherwise not nested.                                                                                                       |
| 9   | Extend with no legal move                         | Rejected with the specific blocking instance named.                                                                                                                                              |
| 10  | Extend past midnight                              | Permitted; produces a carry-in.                                                                                                                                                                  |
| 11  | Host skipped, dependent survives?                 | No. Dependents are skipped with reason `HOST_SKIPPED` at zero cost.                                                                                                                              |
| 12  | Chunked host with dependents                      | `pre` binds to the first chunk, `post` to the last.                                                                                                                                              |
| 13  | Overlap budget partially consumed                 | Remaining budget is per host instance per day; it does not roll over.                                                                                                                            |
| 14  | Absolute exclusion window outside the host        | Host placements that fail to contain it are infeasible; if none remain, the host is skipped.                                                                                                     |
| 15  | Catalogue differs mid-day                         | Existing instances keep their copied rules; a changed template affects nothing until the next `GENERATE_DAY`. Test by solving, mutating the catalogue, and solving again with the same timeline. |
| 16  | Ad-hoc activity outranking everything             | Legal. It is placed in phase 2 first and may displace much of the day. The cost report explains what it cost.                                                                                    |
| 17  | Empty catalogue                                   | An empty timeline with `status = OK` and full idle cost.                                                                                                                                         |
| 18  | `now` past the end of the day                     | Everything backdates; the remainder is empty.                                                                                                                                                    |
| 19  | Activity longer than the whole day                | Validation warning; skipped at solve time with `WINDOW_UNSATISFIABLE`.                                                                                                                           |
| 20  | Caller reuses the input object                    | The engine must not mutate any input. Deep-freeze the input in tests and assert it is unchanged after a solve, including after a rejection.                                                      |
| 21  | Event references an unknown instance id           | `REJECTED` with `UNKNOWN_INSTANCE`. Never a thrown exception, never a silent no-op.                                                                                                              |
| 22  | Event targets a `SKIPPED` or `COMPLETED` instance | `REJECTED` with `INVALID_STATE_FOR_EVENT`, naming the state found and the states allowed.                                                                                                        |
| 23  | Chunking can't reach the full duration            | Accept the partial chunked total (Section 5.5) as long as it clears `min_duration_minutes`; only a total below that floor is `SKIPPED` (see 14.6b).                                              |

---

## 12. Engine API contract

```
solve(input: SolveInput) → SolveResult

SolveResult {
  status      : OK | DEGRADED | REJECTED
  timeline    : Timeline              // on REJECTED, the input timeline, unchanged
  rejection   : RejectionError · null // non-null iff status = REJECTED
  diagnostics : Diagnostic[]
  cost        : CostBreakdown
  trace       : SolveTrace · null     // populated only when input.options.trace = true
}

CostBreakdown {
  total, skip, shrink, chunk, drift, gap, idle : int
  per_instance : map<instance_id, int>
}

SolveTrace {
  phase_timings      : map<phase, ms>
  candidates_evaluated : int
  backtrack_nodes    : int
  decisions          : DecisionRecord[]   // per activity: chosen placement, runner-up, why
}
```

`SolveTrace` is what makes the engine debuggable. When a schedule looks wrong, the trace shows the runner-up placement and the cost difference — usually revealing a mis-tuned constant rather than a logic bug.

### 12.1 The pure function surface

`solve` is the only function the outside world needs. Everything below it is also pure, and each is worth exposing because each is independently testable — that is the entire reason for decomposing this way. A function that needs a mock is a function in the wrong place.

| Function                 | Signature                                                             | Purity notes                                                              |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `solve`                  | `(SolveInput) → SolveResult`                                          | The whole engine. Total: never throws for well-typed input.               |
| `resolveDayFrame`        | `(date, timezone) → DayFrame`                                         | Reads the IANA database, a constant. Same arguments, same frame, forever. |
| `resolveWallClock`       | `(wall, DayFrame) → offset`                                           | DST resolution rules of Section 3.3.                                      |
| `validateActivity`       | `(Activity, CostConstants) → ValidationIssue[]`                       | Section 10.1. Returns issues; never throws.                               |
| `validateCatalog`        | `(Activity[]) → ValidationIssue[]`                                    | Cross-activity checks: rank uniqueness, sequence cycles.                  |
| `seedCandidates`         | `(catalog, existing, carry_in, DayFrame, event) → TimelineActivity[]` | Phase 0. Instance rule overrides survive here or nowhere.                 |
| `computeFreezeBoundary`  | `(TimelineActivity[], now) → offset`                                  | Section 6.3.                                                              |
| `applyTimeTransitions`   | `(TimelineActivity[], now) → TimelineActivity[]`                      | Auto-start, auto-complete, backdating.                                    |
| `computeFreeIntervals`   | `(occupied[], from, to) → Interval[]`                                 | Pure interval arithmetic. Heavily property-testable.                      |
| `computeNestableRegions` | `(host, guest) → Interval[]`                                          | Host span minus exclusions, siblings, and budget.                         |
| `enumerateCandidates`    | `(activity, Interval[], DayFrame) → Placement[]`                      | Section 8.6 steps 1–2. Deterministic order.                               |
| `isFeasible`             | `(Placement, activity, context) → bool \| InfeasibilityReason`        | Section 8.6 step 3. One predicate per rule type underneath.               |
| `placementCost`          | `(Placement, activity, CostConstants) → int`                          | Section 7.3, excluding idle.                                              |
| `scheduleCost`           | `(Timeline, CostConstants) → CostBreakdown`                           | Whole-timeline cost including idle.                                       |
| `placeActivity`          | `(activity, context) → PlacementResult`                               | Sections 8.6–8.7. The core routine.                                       |
| `placeHardSet`           | `(candidates, context) → PlacementResult[]`                           | Phase 1, with bounded backtracking.                                       |
| `placeGreedy`            | `(candidates, context) → PlacementResult[]`                           | Phase 2.                                                                  |
| `checkInvariants`        | `(Timeline) → InvariantViolation[]`                                   | Section 4.5. Called at the end of every solve.                            |
| `checkRejection`         | `(before: Timeline, after: Timeline, event) → RejectionError \| null` | Section 10.2, always a before/after comparison.                           |
| `renderAscii`            | `(Timeline) → string`                                                 | Section 13. Pure formatting, snapshot-testable.                           |

### 12.2 Purity rules, stated as obligations

These are not style preferences. Each one is the precondition for a specific kind of test being possible at all.

1. **No `Date.now()`, no `new Date()` without arguments, anywhere below `solve`.** Time enters as `input.now` and as `input.day_frame`. Enforce with a lint rule; it will save you a week.
2. **No mutation of any input.** Every function returns new values. Tests deep-freeze inputs and assert equality afterwards.
3. **No randomness, no iteration over unordered collections.** Where a map must be iterated, sort its keys first. Set iteration order is a silent determinism leak.
4. **No exceptions for expected outcomes.** Infeasibility, rejection, and validation failure are all return values. Exceptions are reserved for programmer error — a broken invariant, a malformed type — and should crash loudly rather than degrade quietly.
5. **No logging inside the engine.** The `SolveTrace` is the logging mechanism, and it is a return value.
6. **All configuration is an argument.** `CostConstants`, `GRID`, and node limits arrive in `SolveInput`, with defaults supplied at the boundary. No module-level constants that a test cannot vary.

---

## 13. Terminal harness

The harness is a thin program that reads a scenario file, calls `solve`, and prints the result. It holds no logic of its own — if you find yourself computing something in the harness, it belongs in the engine.

Its purpose is to make the engine _legible_. Unit tests tell you whether a specific assertion holds; the harness lets you look at a day and notice that it is subtly stupid in a way you never thought to assert.

```
06:30 ┌ Commute            30m   [pre → Work]
07:00 ├ Work              480m   ████████████████  strict 07:00-18:00
      │   └ 08:00-09:00   Focus Hour  (exclusion)
      │   └ 09:30-10:00   Email  30m  (guest, budget 30/60 used)
15:00 ├ ·· idle 60m ··
16:00 ├ Gym                45m   ▓▓▓  SHRUNK 60→45
17:00 ├ Dinner             45m   ██   flexible 17:00-19:00, drift 0
      ╳ Reading                   SKIPPED — NO_FREE_SPACE

cost: total 1840 | skip 0 | shrink 600 | chunk 0 | drift 0 | idle 240
status: OK
```

### 13.1 Scenario files

A scenario is a catalogue plus a script of events. It is the only input format the harness understands, and it is the same format the test fixtures use.

```
Scenario {
  name       : string
  date       : YYYY-MM-DD
  timezone   : IANA zone
  catalog    : Activity[]
  steps      : Step[]
}

Step {
  at         : wall-clock time      // becomes `now` for this solve
  event      : Event                // TICK when omitted
  expect     : Expectation · null   // optional inline assertion
}

Expectation {
  status              : OK | DEGRADED | REJECTED
  rejection_code      : string · null
  placements          : map<activity_name, "HH:MM-HH:MM" | "SKIPPED">
  total_cost          : int · null
}
```

The harness folds the steps: each step's output timeline becomes the next step's input. This is the whole of its logic, and it mirrors exactly how a real caller would use the engine.

### 13.2 Commands

| Command                        | Effect                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| `run <scenario.json>`          | Execute every step, print each resulting day                      |
| `run <scenario.json> --step N` | Execute up to step N only                                         |
| `run <scenario.json> --diff`   | Print only what changed between consecutive steps                 |
| `run <scenario.json> --trace`  | Include `SolveTrace`: chosen vs. runner-up placement per activity |
| `run <scenario.json> --json`   | Emit the raw result, for piping or for creating a fixture         |
| `check <scenario.json>`        | Evaluate inline expectations; exit non-zero on mismatch           |
| `repl <scenario.json>`         | Load the catalogue, then accept events interactively              |

REPL commands mirror the events one-to-one: `tick 14:30`, `finish-early gym`, `extend work 15`, `adhoc "Doctor" 60 --fixed 10:00-11:00 --rank 2`, `skip reading`, `undo`, `cost`, `why gym`.

`why <activity>` is the highest-value command in the harness and worth building early. It prints that activity's decision record from the trace: which placements were feasible, what each cost, which was chosen, and — when it was skipped — the specific reason code and the constraint that produced it.

### 13.3 Why the ASCII renderer matters

`renderAscii` is a pure function from `Timeline` to `string`, which makes it both the harness's display layer and the most convenient snapshot assertion in the test suite. A single expected-output string catches placement, duration, nesting, relaxation, and cost regressions simultaneously, and reads as documentation while doing it.

Keep the format stable and fully deterministic — no timestamps, no elapsed-time counters, nothing derived from the wall clock — or every snapshot in the suite becomes flaky at once.

---

## 14. Worked examples

These double as the first entries in the test corpus. Each is a fixture: input JSON, expected output timeline.

### 14.1 Baseline weekday

**Catalogue:** Work (rank 1, 480m, strict 09:00–18:00, mandatory, overlap 60m guests=[Email], relative exclusion 60–120) · Commute (rank 2, 30m, pre→Work) · Dinner (rank 3, 45m, flexible 19:00–20:30 drift 30, mandatory) · Gym (rank 4, 60m, flexible 18:00–20:00 drift 30, shrink floor 45) · Email (rank 5, 30m) · Reading (rank 6, 45m, flexible 21:00–23:00 drift 60, shrink floor 20, chunking min 15)

**Expected:** Commute 08:30–09:00 · Work 09:00–17:00 with Focus Hour 10:00–11:00 and Email nested 09:00–09:30 · Gym 18:00–19:00 · Dinner 19:00–19:45 · Reading 21:00–21:45. Zero relaxations. Status `OK`.

### 14.2 Extend cascades into a shrink

Same catalogue, but Dinner is `FixedRule` 19:00–19:45 and Gym is mandatory. Work is extended repeatedly until it ends at 18:10.

**Expected:** Gym cannot take 60 minutes — the gap 18:10–19:00 is 50 minutes, and placing it after 19:45 would drift 45 minutes past a 30-minute allowance. It shrinks to 45 minutes at 18:10–18:55. Diagnostic: "Gym shortened from 60 to 45 minutes." Status `OK`, not a rejection — shrinking is a legal relaxation.

### 14.3 Extend rejected

Same as 14.2, but Gym has no ShrinkRule. Extending Work to 18:10 leaves no legal placement for a mandatory 60-minute Gym.

**Expected:** `status = REJECTED`, `rejection.code = MANDATORY_UNPLACEABLE`, `conflicting_instance_ids = [gym]`. The returned timeline is the input timeline: Work still ends at 18:05. Assert this by deep-equality against the pre-event timeline, not by spot-checking Work's end.

### 14.4 Ad-hoc rejected on a strict conflict

Baseline day. The user adds an ad-hoc "Doctor" with `FixedRule` 10:00–11:00. Work is mandatory, 480 minutes, strict 09:00–18:00, and has no shrink rule. The largest remaining contiguous span inside the window is 11:00–18:00 = 420 minutes.

**Expected:** `status = REJECTED`, `rejection.code = MANDATORY_UNPLACEABLE`, `conflicting_instance_ids = [work]`. Suggested fix: "Add a Shrink Rule to Work, or widen its window." `best_effort_timeline` shows the day that was refused, with Work skipped.

### 14.5 Finish early restores a skipped activity

Baseline day, but Reading was skipped at generation because the day was full. At 15:00 the user finishes Work early.

**Expected:** the remainder re-solves; Reading is placed at 21:00–21:45 at full duration. No special-case logic — the from-scratch re-solve produces it. Diagnostic: "Reading restored after Work finished early."

### 14.6 Chunking beats skipping

Deep Work: 120m, flexible 09:00–17:00 drift 0, shrink floor 60, chunking allowed, min chunk 45, max 3. The day has two free gaps: 09:00–10:00 and 14:00–15:00.

**Expected:** two chunks of 60 minutes each. Cost = one extra chunk (`W × 200`), versus skipping (`W × 10 000`) or shrinking to a single 60-minute block (`60 × W × 20 = 1200W`). Chunking wins. Both blocks share a `chunk_group_id`.

### 14.6b Chunking completes an activity partially

Same Deep Work (120m, flexible 09:00–17:00 drift 0, shrink floor 90, chunking allowed, min chunk 45, max 3), but the day is more congested: its two free gaps are only 09:00–09:50 and 13:00–13:50 — 50 minutes each, 100 minutes total. No single contiguous span reaches even the 90-minute floor, so the single-block path has nothing to offer at all.

**Expected:** two chunks, 09:00–09:50 and 13:00–13:50, `scheduled_minutes = 100`. Status `OK`, not `SKIPPED` — 100 clears the 90-minute floor even though it falls short of the full 120. Relaxations recorded once, on the first chunk: shrink 20 minutes (120 → 100) and one extra chunk. Had the two gaps summed to less than 90, the activity would be `SKIPPED` with reason `NO_FREE_SPACE`, same as a single block that can't reach its own floor.

### 14.7 Guest displaced by an exclusion window

Work 09:00–17:00 with an absolute exclusion window "Customer Call" 09:00–10:00. Email is a 30-minute guest with a strict window 09:00–10:00.

**Expected:** Email cannot nest — its only legal window is entirely excluded. It falls back to a top-level placement if its window permits, otherwise `SKIPPED` with reason `WINDOW_UNSATISFIABLE`.

### 14.8 Midnight span and carry-in

Night Shift: fixed 22:00–06:00.

**Expected:** day A holds 22:00–24:00. Day B opens with a locked `CARRIED_IN` block 00:00–06:00 labelled "Spanning from yesterday". Finishing it early at 04:00 frees 04:00–06:00 and re-solves day B from 04:00.

---

## 15. Out of scope for v1

Recorded so a reader knows these omissions are deliberate.

**Outside the engine by definition** — the engine is a library and has no opinion on any of these:

- Storage of any kind. The caller owns the catalogue and the timeline and hands both back on the next call.
- Transport, processes, scheduling of when `solve` runs, and every user interface.
- Notifications. The engine reports state transitions in its result; delivering them is someone else's job.

**Genuine feature omissions, deferred:**

- Tracking ledgers, weekly goals, rolling deficits, streaks. The solver optimises one day in isolation.
- Multi-day lookahead. Tomorrow is not considered when solving today, except for carry-in.
- Reality-check prompts. Auto-completed activities are assumed perfect.
- Multiple instances of the same template per day.
- Travel-time estimation, location awareness, external calendar import.
- Shared or multi-user schedules.
- Learning from history to adjust durations.

---

## 16. Build order and acceptance

Build in this order. Each step is independently demonstrable and each ends in a working artefact.

| #   | Step                                                                | Done when                                                                |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Types, interval arithmetic, `resolveDayFrame`, `renderAscii`        | Unit tests on intervals and DST pass; a hand-built timeline prints       |
| 2   | Terminal harness: `run` on a scenario with no rules                 | One command prints a day from a JSON file                                |
| 3   | Solver v0: durations and priority only, no rules                    | Five activities pack in rank order; first snapshot test                  |
| 4   | Cost model, `scheduleCost`, the dominance validator                 | Cost breakdown prints; an invalid template is refused with a named field |
| 5   | FixedRule → MandatoryRule → the two-pass structure                  | 14.4 detects infeasibility                                               |
| 6   | StrictWindowRule → FlexibleWindowRule with drift                    | 14.1 reproduces exactly                                                  |
| 7   | SequenceRule with dependent-skip semantics                          | Commute follows Work and skips with it, at zero cost                     |
| 8   | ShrinkRule: shrink first, then chunking                             | 14.2, 14.6, and 14.6b pass                                               |
| 9   | OverlapRule: nesting, budget, exclusion windows                     | 14.1 and 14.7 pass                                                       |
| 10  | Events: tick, backdate, finish early, extend, ad-hoc, rule override | 14.3 and 14.5 pass; `REPL` becomes usable                                |
| 11  | Rejection layer: `checkRejection` before/after comparison           | Every code in Section 10.2 has a reaching test                           |
| 12  | Midnight spanning, carry-in, DST                                    | 14.8 passes on 1380-, 1440-, and 1500-minute days                        |

Steps 1–3 should take a day or two and will teach you more about the design than another week of specification. Nothing here requires a decision you have not already made.

### 16.1 Test strategy (vitest)

Constraint-engine bugs are combinatorial and invisible: fixing drift handling silently breaks chunking, and no amount of looking at the harness output will reveal it. Because the engine is pure, the tests need no mocks, no fake timers, no setup, and no teardown — every test is `expect(solve(input))`. This is as cheap as testing ever gets, so there is no excuse for thin coverage.

Five layers, in descending order of how many of them you should write:

**1 — Unit tests on the small pure functions.** Interval arithmetic, `resolveWallClock`, `placementCost`, `isFeasible`. Table-driven with `describe.each` / `test.each`, since almost every one of these is a truth table:

```
test.each([
  // window 18:00-20:00, duration 60
  ["fully inside",   1080, 60,  0,  true ],
  ["15m early",      1065, 60, 15,  true ],
  ["at drift limit", 1170, 60, 30,  true ],
  ["over the limit", 1215, 60, 60, false ],
])("drift %s", (_, start, dur, expectedDrift, feasible) => { ... })
```

The drift table above _is_ Section 5.3's table. Copy the spec's tables into `test.each` arrays verbatim; when the spec and the tests disagree, one of them is wrong and you find out immediately.

**2 — Scenario tests through `solve`.** One file per rule type — `strict-window.test.ts`, `shrink.test.ts`, `overlap.test.ts` — plus `events.test.ts` and `rejection.test.ts`. Each builds a small catalogue with a fixture builder and asserts on placements:

```
expectPlacements(result, {
  Work:    "09:00-17:00",
  Gym:     "18:00-18:45",   // shrunk
  Reading: "SKIPPED",
})
```

Write this helper first. Comparing a placement map against an expected map gives far better failure output than a chain of individual `expect` calls, and it catches unintended collateral movement — the failure mode where you assert Gym shrank correctly and never notice that Reading vanished.

**3 — Snapshot tests over `renderAscii`.** One per worked example in Section 14, using `toMatchSnapshot()`. Store snapshots as committed files and read the diffs in review; a placement regression shows up as a visibly wrong day rather than a changed integer. Keep these to the eight or so canonical scenarios — snapshots are excellent documentation and terrible fine-grained assertions, because a snapshot suite that everyone reflexively updates with `-u` is worse than no suite at all.

**4 — Invariant tests, run on every result.** Wrap `solve` in a test-only helper that calls `checkInvariants` (Section 4.5) and fails if it returns anything. Route every test through that helper. This turns each of the couple of hundred scenario tests into an invariant test for free, and it is the single highest-leverage thing in this section.

**5 — Property tests.** Use `fast-check` alongside vitest. Generate random catalogues within the grammar and assert the properties that must hold universally:

| Property           | Assertion                                                                          |
| ------------------ | ---------------------------------------------------------------------------------- |
| Determinism        | `solve(x)` twice is deeply equal                                                   |
| Input immutability | Deep-frozen input is unchanged after a solve, including after a rejection          |
| No overlap         | No two top-level blocks intersect                                                  |
| Shrink floor       | Every scheduled instance has `scheduled_minutes ≥ floor`                           |
| Mandatory          | If a feasible schedule exists, no mandatory activity is skipped                    |
| Cost monotonicity  | Removing an activity from the catalogue never increases the total cost of the rest |
| Tick idempotence   | `TICK(t)` twice from the same state changes nothing the second time                |
| Rejection purity   | A rejected solve returns a timeline deeply equal to its input                      |

Property tests are where you will find the bugs that scenario tests cannot reach, because they explore combinations you would never think to write down.

**Regression discipline.** Every bug becomes a test before it becomes a fix — a scenario test naming the wrong behaviour it produced. That corpus is the other half of this document: the cases that cannot be expressed clearly in prose get expressed as executable examples instead.

### 16.2 Fixture builders

Hand-writing a full `Activity` in every test is what kills constraint-engine test suites: the boilerplate grows until nobody writes the next test. Build a small fluent factory first, with sensible defaults, so that each test states only what it is actually about:

```
activity("Gym").rank(4).minutes(60)
  .flexible("18:00", "20:00", { drift: 30 })
  .shrink({ floor: 45 })
```

Everything unstated takes a default. A reader of a failing test should see the three properties that matter to it and nothing else.

### 16.3 Acceptance criteria for v1

1. All eight worked examples in Section 14 pass as scenario tests, with committed snapshots.
2. All twenty-three edge cases in Section 11 have a named test and pass.
3. Every rejection code in Section 10.2 and every validation code in Section 10.1 is reached by at least one test.
4. Every property in Section 16.1 layer 5 holds over at least 1,000 generated cases.
5. `checkInvariants` runs on every result produced anywhere in the suite and never fires.
6. Two identical solves produce deeply equal output; the engine contains no clock read and no unsorted iteration.
7. A full solve of a 20-activity day completes in under 100 ms.
8. The engine package imports nothing but the standard library and a timezone database — no framework, no I/O, no transport.
9. The terminal harness exercises every event type against a real scenario file.
