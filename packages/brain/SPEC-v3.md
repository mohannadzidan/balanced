# Dynamic Day Scheduler — Engine Specification, v3 (Simplification)

**Status: subtractive respecification. Deletes the stateful orchestration
layer; the placement math is untouched.**

This document specifies **v3** of the engine. It is a companion to
`PRD.md` (the consolidated description of the engine as it exists going
into this change), not a replacement for it. Every rule type, every phase
of the solver, the cost model, and the recurrence/expansion machinery
described in `PRD.md` §5–§7 and §9–§10 remain authoritative and are
deliberately not restated here except where this document changes them.
Where this document is silent, `PRD.md` governs.

This document contains no source code and no pseudo-code. Every data shape
is described as a table of fields; every procedure is described in prose.
A reader implementing this should treat the tables as the contract and the
prose as the specification of behaviour.

---

## Table of contents

1. [Why this document exists](#1-why-this-document-exists)
2. [The acceptance criterion](#2-the-acceptance-criterion)
3. [What "stateful orchestration" means here](#3-what-stateful-orchestration-means-here)
4. [The new mental model](#4-the-new-mental-model)
5. [Glossary changes](#5-glossary-changes)
6. [The window](#6-the-window)
7. [The locking model](#7-the-locking-model)
8. [Spanning past the window](#8-spanning-past-the-window)
9. [What is deleted, and where its job goes](#9-what-is-deleted-and-where-its-job-goes)
10. [What does not change](#10-what-does-not-change)
11. [The simplified pipeline](#11-the-simplified-pipeline)
12. [The function contract](#12-the-function-contract)
13. [Validation changes](#13-validation-changes)
14. [Cookbook: old events as caller patterns](#14-cookbook-old-events-as-caller-patterns)
15. [Migration](#15-migration)
16. [Out of scope](#16-out-of-scope)
17. [Acceptance criteria for this simplification](#17-acceptance-criteria-for-this-simplification)

---

## 1. Why this document exists

The engine's placement logic — the part that decides where an activity
goes given its rules, its priority, and what else is already occupying the
day — is sound and well-tested. Around that core, three drops of prior
work (`SPEC.md`, `SPEC-v2.md`, `SPEC-v2.1.md`) accreted a second system: an
event layer with eight event types, a five-state lifecycle with automatic
transitions, a backdating horizon, a freeze-boundary computation, a
speculative-solve-and-reject mechanism, a cross-frame carry-in/prelude
pair, and a rule that instance-level overrides must survive an arbitrary
number of later calls. None of that is scheduling math. All of it exists
to let the engine remember what happened last time and decide, on the
caller's behalf, whether to let something change.

That memory is redundant. The embedding application already has a
database (`packages/brain`'s consumer is `apps/web`, backed by Turso per
the project's own constitution) and already knows, better than the engine
ever can, what actually happened to a person's day. Asking the engine to
also track it means two sources of truth that can silently disagree, and a
public surface — the `Event` union, five lifecycle states, `revision`,
`finalised`, `carryIn`, `prelude` — that a caller has to learn before
placing a single activity.

v3 deletes the second system. What is left is one pure function: give it a
window and a list of activities — some already pinned down, some not — and
it returns the best placement of the ones that aren't. Nothing more.

## 2. The acceptance criterion

> **No rule type, no cost formula, no phase of the placement search, and
> no recurrence/expansion behaviour changes.** Only the shell that decides
> what gets fed into the search, and what shape comes out, changes.

Concretely: for any scenario expressible in both v2.1 and v3 — a single
call, no locked-excluded entries, a window equal to one calendar day
starting at local midnight — the two engines must produce the same
placements, the same costs, and the same diagnostics, modulo the field
renames and deletions this document makes explicit. If a placement moves
or a cost changes, this document is implemented wrong; the fix is to the
implementation, not to a test snapshot.

## 3. What "stateful orchestration" means here

Everything in this list exists in the engine today specifically to let one
`solve()` call know what an earlier call decided, without the caller
repeating itself. v3's position is that the caller was always going to
have that information anyway (it is the thing being scheduled, in its own
persistent store), so the engine carrying it too is pure duplication:

- The `Event` discriminated union and its per-event preconditions/mutations
  (`GENERATE_DAY`, `TICK`, `SKIP`, `RESTORE`, `FINISH_EARLY`, `EXTEND`,
  `ADD_ADHOC`, `EDIT_INSTANCE_RULES`, `FINALISE_FRAME`).
- The five-state lifecycle (`PLANNED`, `ACTIVE`, `COMPLETED`, `SKIPPED`,
  `CARRIED_IN`) and its automatic transitions (auto-start, auto-complete,
  backdating, `backdateHorizonMinutes`).
- The freeze-boundary computation derived from `now` plus lifecycle state.
- The speculative-solve-and-compare rejection mechanism
  (`checkEventRejection`, `RejectionError`, `REJECTED` as a status).
- `carryIn` and `prelude` as two different, partially-overlapping
  mechanisms for expressing "occupancy that crosses a frame boundary."
- `Timeline.revision` and `Timeline.finalised`.
- The rule that an instance-level rule override (`source: "instance"`)
  must be re-applied, unconditionally, on every subsequent call, or it is
  silently lost.
- The reconstruction of ad-hoc pseudo-activities from prior instances
  (`adhocActivitiesFrom`) and the per-call recomputation of the priority
  ranking denominator that reconstruction exists to feed.

Every item above is deleted in v3. Section 9 gives each one a one-line
replacement; Section 14 gives worked patterns for the common cases.

## 4. The new mental model

1. **`solve()` is one pure function taking a window and a list of
   activities, and returning a placement of that list.** There is no
   second argument describing "what changed" — the caller expresses a
   change by constructing a different activities list and calling again.
2. **The engine has no memory across calls, and needs none.** Every call
   is solved from the information it is given. There is no `now`
   parameter, because nothing inside the engine needs to know the current
   instant — it only needs to know where the window starts, and which
   activities are no longer negotiable.
3. **"Already decided" is a property of one activity entry, not a fact
   about time.** An activity is either open for placement or it is locked.
   Locking is expressed on the entry itself (Section 7), not derived by
   the engine comparing a timestamp against a state machine.
4. **The engine does not know, and does not need to know, whether its
   output will ever be looked at again.** There is no "finalise" call.
   Whether a caller treats a result as provisional or permanent, and for
   how long, is entirely the caller's bookkeeping.
5. **Calling `solve()` twice with the same input is calling it once.**
   This was previously a property (`TICK` idempotence) that had to be
   engineered and separately tested. In v3 it is a free consequence of the
   function being pure and stateless — there is nothing left that could
   make a second identical call behave differently from the first.

Everything else in `PRD.md`'s design tenets (§2: pure function, full
re-solve of the affected region every time, time as an argument, results
that explain themselves) is unchanged and restated here for completeness,
not revised.

## 5. Glossary changes

Terms retained unchanged from `PRD.md` §3: **Activity**, **Rule**,
**Occurrence**, **Placement**, **Host / Guest**, **Exclusion window**,
**Relaxation**, **Free interval**.

| Term | v2.1 meaning | v3 meaning |
| --- | --- | --- |
| **Window** | Not a first-class concept; expressed as `Frame` (always a whole number of local midnight-to-midnight days) plus `SolveOptions.scope` (a sub-range of it) | The single top-level input: an arbitrary start instant and end instant, in a given timezone. Replaces `Frame` + `scope` as the unit `solve()` operates on. See Section 6. |
| **Anchor** | A block the solver may not move, arising from lifecycle state (`ACTIVE`/`COMPLETED`/`CARRIED_IN`) or an explicit `locked` flag | An activity entry the caller has explicitly marked **locked** (Section 7). No lifecycle state produces an anchor implicitly — every anchor is one the caller declared. |
| **TimelineActivity / instance** | Carries a five-state lifecycle, `actualStart`/`actualEnd`, `completedSource`, `spanningFromPreviousDay` | Carries only what's needed to describe a placement: identity, timing, and whether it's locked. Lifecycle bookkeeping is gone (Section 9). |
| **Timeline** | A stateful record with `revision` and `finalised` | A **Result**: a plain value with no notion of being "current" or "the latest." Nothing refers back to a previous result implicitly. |

New term:

| Term | Meaning |
| --- | --- |
| **Excluded entry** | A locked activity entry that has deliberately been given no placement. It consumes no time and no budget, and the solver does not attempt to place it. Replaces `SKIPPED, locked: true` (Section 7.2). |

Retired terms, with no replacement, because the concept they named no
longer exists anywhere in the engine: **Speculative solve**, **frozen
region** (the window's start already is the boundary; nothing "freezes"
because there is nothing to freeze it against), **carry-in**, **prelude**,
**finalised**, **revision**.

## 6. The window

`solve()` takes exactly one top-level scheduling unit: a **window** — a
start instant, an end instant, and the IANA timezone the activities'
wall-clock rules should be read against. The window replaces both `Frame`
(a whole number of local midnight-to-midnight days) and `SolveOptions.scope`
(a sub-range within it) as v2.1 had them. There is exactly one range now,
not two nested ones.

### 6.1 What is no longer required

`PRD.md` §4.2 states an invariant: "a frame always starts at local
midnight," and says it is "never relaxed." v3 relaxes it, because it is
the one thing standing between the current engine and the two usage
patterns this simplification exists to support:

- **Day-by-day scheduling.** Call `solve()` once per calendar day, with a
  window that happens to run midnight to midnight. This is the v2.1
  behaviour, unchanged, expressed as a special case of the general window
  rather than the only shape the engine understood.
- **Rescheduling the rest of a day.** Call `solve()` with a window that
  starts at whatever instant "now" is for the caller and ends at the end
  of the calendar day (or wherever else the caller wants to stop
  planning). No `scope` argument is needed to express this, because it is
  now simply what a window *is*.

A window's start and end need not fall on a `GRID` boundary at the
timezone's local-midnight granularity; they still must be minute-aligned,
same as every other time value in the engine (`PRD.md` §4.1).

### 6.2 What the engine still derives internally

Everything `PRD.md` §4 describes about per-day length, DST, and wall-clock
resolution is unchanged in substance — it is simply computed over
whichever local calendar days the window happens to touch, rather than
over a caller-declared `dayCount`. Concretely, the engine:

- Determines the ordered list of local calendar dates the window's
  `[start, end)` span intersects, in the window's timezone. The first and
  last of these may be **partial days** — the window need not start or
  end at that date's local midnight.
- Computes each date's true length in minutes from the timezone database
  (1440 normally, 1380 or 1500 across a DST transition), exactly as
  before, so per-day wall-clock windows and weekday eligibility resolve
  correctly regardless of where inside a day the window itself starts or
  ends.
- Uses this day table for exactly what it was used for before: resolving
  `WindowRule` wall-clock times to window-relative offsets, determining
  weekday eligibility, and partitioning `RepeatRule` buckets (`day`,
  `week`, `month`, `frame` — where "frame" now means "the whole window").

Nothing about DST handling, spanning-midnight `WindowRule`/`FixedRule`
resolution, or bucket partitioning changes in behaviour. What changes is
only that the day table's first and last entries may be shorter than a
full calendar day, because the window sampled only part of them.

### 6.3 `defaultDayWindow`

Retained unchanged (`PRD.md` §6.2.2): a caller may still declare a default
per-day wall-clock window applied to any activity with no `WindowRule` of
its own. It is a plain default value, not a piece of lifecycle state, and
nothing about this simplification touches it.

## 7. The locking model

Every activity entry passed into `solve()` is in exactly one of two
states, and this replaces the entire five-state lifecycle
(`PLANNED`/`ACTIVE`/`COMPLETED`/`SKIPPED`/`CARRIED_IN`) end to end.

### 7.1 Open

An **open** entry is a template (or, under recurrence, a single occurrence
of one) that the solver is free to place, shrink, chunk, drift, or skip,
exactly per its rules and the cost model — unchanged from `PRD.md` §5–§10.
Nothing distinguishes an open entry from a "brand-new ad-hoc activity" or
"an activity the caller has scheduled before" — the engine has no concept
of an activity's history, so there is nothing to distinguish.

### 7.2 Locked

A **locked** entry's placement decision has already been made outside the
engine, and the solver must not revisit it. There are two forms:

| Form | Meaning | Space/budget effect | Cost effect |
| --- | --- | --- | --- |
| **Locked, occupied** | The entry has an explicit start and end, supplied by the caller. | Occupies that exact span. Participates in overlap/exclusion/adjacency checks against every other entry exactly as a solver-placed block would. | None — an occupied entry is neither shrunk, drifted, nor charged an unscheduled-minute cost, because the engine did not place it and is not being asked to evaluate the placement. |
| **Locked, excluded** | The entry has deliberately been given no placement at all. | Consumes no time and no budget. | Charged the ordinary skip cost for its priority weight (or infinite, if it is a required occurrence), exactly as a solver-caused skip would be — a deliberate exclusion is not free, so the cost report stays comparable across calls. Reported with a distinct diagnostic code (Section 13) so a caller can tell "I chose to drop this" apart from "the solver couldn't fit this." |

A locked entry, in either form, is never re-evaluated against its rules —
the engine trusts the caller's declaration completely. This is what makes
"already started" and "already finished" activities unmovable without any
notion of `now`, `ACTIVE`, or `COMPLETED`: the caller simply describes the
span it actually occupied (or is currently occupying) and marks it locked.

### 7.3 What this replaces

The caller expresses, entirely through which entries are locked and how:

- **A task in progress** — locked, occupied, with its start at whenever it
  actually started and its end at whatever the caller currently believes
  it will end (its planned end, if nothing has changed; a longer or
  shorter value, if the caller has since learned otherwise).
- **A finished task** — locked, occupied, with its end at when it actually
  ended.
- **A user-dismissed activity** — locked, excluded.
- **Everything before the window's start** — not part of the input at
  all. There is no separate "frozen region" to compute; an entry the
  caller doesn't include isn't part of this call's problem, and an entry
  the caller does include but marks locked-occupied simply occupies its
  declared span, wherever that falls relative to the window (Section 8).

### 7.4 Forward-only placement

The solver only ever proposes a start time at or after the window's start,
for every open entry. This is the entirety of "the scheduler always tries
to schedule forward" — it requires no boundary computation distinct from
the window itself, because the window's start *is* the boundary. A locked
entry is exempt from this, by construction, since the solver never
proposes anything for it in the first place (Section 8 covers the case
where a locked entry's own span reaches outside the window).

## 8. Spanning past the window

Two related behaviours, both already true in `PRD.md` (§4.5, §10.10,
§8.5) under three different mechanism names (day-boundary spanning,
`prelude`, `carryIn`), collapse into one rule in v3:

**A locked-occupied entry's span may extend outside `[windowStart,
windowEnd)` on either side, or both.** The engine only needs to know that
span to determine occupancy; it does not require the span to fit inside
the window, and it performs no special handling at either boundary. This
single rule covers:

- Occupancy carried over from before the window starts (previously
  `prelude`) — e.g. a sleep block that began the night before and is still
  running when this window opens.
- Occupancy that will still be running after the window ends (previously
  `carryIn`, produced by `FINALISE_FRAME`) — e.g. that same sleep block,
  from the point of view of the call that placed it.

Neither case requires the caller to do anything beyond constructing the
entry with the span it actually has. There is no round-trip data structure
to assemble (`prelude`'s caller-side subtraction described in `PRD.md`
§10.10 is gone), and no automatic clamp-and-duplicate step (`FINALISE_FRAME`'s
behaviour in `PRD.md` §8.5 is gone) — because there is no longer a boundary
event that would need to trigger one. If the caller wants tomorrow's call
to know that today's sleep block is still running, it constructs
tomorrow's locked-occupied entry from today's result, in tomorrow's
window's coordinates, the same way it constructs every other locked entry.

**An open entry's resolved placement may end after the window's end, if
its own rules allow it.** This is `PRD.md` §4.5's spanning-window
behaviour, unchanged: window containment, not the window's own length,
bounds a placement, so a `strict` sleep window that starts near the
window's end and is declared to run past midnight is still placed in full.
What the caller does with that overflow — most commonly, feeding it back
as tomorrow's locked-occupied entry — is exactly the caller-side pattern
above, and is identical whether the entry started as open or was already
locked.

## 9. What is deleted, and where its job goes

| Deleted | Why it existed | Where its job goes now |
| --- | --- | --- |
| `Event` union and `planEvent`/`runEvent` | Let one call express "what changed" relative to a previous call | The caller constructs a different activities list and calls `solve()` again. Section 14 gives the pattern for each former event. |
| Five-state lifecycle, auto-start, auto-complete, backdating, `backdateHorizonMinutes` | Let the engine infer, from `now`, which blocks were no longer negotiable | The caller marks an entry locked (Section 7) using whatever it knows from its own clock and its own store. The engine never reads a clock. |
| Freeze boundary computation | Told the solver where "the past" ended | The window's start (Section 6); nothing before it is part of the call. |
| `checkEventRejection` / `RejectionError` / `REJECTED` status | Let a caller ask "would this action make things worse?" without doing the comparison itself | The caller calls `solve()` with the activities list as it stands today, then again with its proposed change, and compares the two results itself. `solve()` is cheap and pure, so this costs one extra call, not a new mechanism. |
| `prelude` / `carryIn` / `FINALISE_FRAME` | Expressed occupancy crossing a call boundary | A locked-occupied entry whose span reaches outside the window (Section 8). One mechanism instead of three. |
| `Timeline.revision` | Distinguished "nothing changed" from "something changed" across calls | Not needed — a caller comparing two results for equality can just compare them; nothing increments because nothing is a sequence. |
| `Timeline.finalised` / `SPANS_FROZEN_REGION` | Refused further events against a day the caller had closed out | The caller simply stops calling `solve()` for that window once it considers the matter closed. There is nothing for the engine to refuse. |
| Instance-rule-override survival (`source: "instance"` reapplied every call) | Let an edit to one instance's rules outlive the call that made it | The caller includes the edited rules on the entry it passes in, every time it calls `solve()` for that entry. There is no "surviving" because there is no session for it to survive across. |
| Ad-hoc reconstruction (`adhocActivitiesFrom`) and per-call `totalRanked` recomputation | Rebuilt a pseudo-activity from a prior instance so an ad-hoc addition could be re-ranked each call | Gone as a distinct mechanism — an ad-hoc activity is just an open entry in the list like any other; the priority-ranking denominator is simply the length of the activities list given to *this* call (Section 12.3), every time, with no special case. |
| `UNKNOWN_INSTANCE` / `INVALID_STATE_FOR_EVENT` | Validated an event's target against remembered state | Not applicable — there is no event and no target to look up; a caller either includes an entry in its list or doesn't. |

## 10. What does not change

Stated explicitly, because the value of a subtractive change depends on
the blast radius staying small, exactly as `SPEC-v2.md` §9 stated it for
Drop 1.

**Entirely unchanged:** the full rule vocabulary and compatibility matrix
(`PRD.md` §6); the cost model, priority weight, dominance invariant, and
tie-breaking (`PRD.md` §9); recurrence and expansion, buckets, ghosting
(`PRD.md` §7); the phase order — fixed placement, the hard set, greedy
placement, sequence dependents (`PRD.md` §10.3–§10.7); overlap nesting,
budgets, and exclusion windows (`PRD.md` §6.6); DST resolution, spanning
windows, and midnight arithmetic within a window (`PRD.md` §4.3–§4.5,
carried into Section 6.2 above); structural invariants (`PRD.md` §16);
determinism, input immutability, and every other purity obligation
(`PRD.md` §15).

**Unchanged in shape, changed only in what feeds them:** the single-
activity placement search, the shrink/chunk ladder, and diagnostics
(`PRD.md` §10.6, §10.8) — they operate exactly as before on whichever
entries the simplified Phase 0 (Section 11) hands them.

## 11. The simplified pipeline

`PRD.md` §10.1's six-step setup collapses to three steps, because steps 3
(`finalised` short-circuit), 4 (`carryIn` merge), and 6 (instance-rule-
override reapplication) no longer exist as distinct concerns:

1. **Cost constants** resolve by layering any caller-supplied override over
   the defaults, unchanged (`PRD.md` §10.1 step 1).
2. **The ranking denominator** is fixed as the number of activity entries
   in this call's list — no exceptions, no recomputation step, because
   there was never a prior call's value to preserve or override.
3. **The candidate set** is exactly the entries the caller passed in:
   locked entries are partitioned into occupied (space-consuming) and
   excluded (cost-only, no placement attempt); every other entry is
   expanded per its recurrence rule (`PRD.md` §7) into the occurrences the
   solver will actually place.

From there, Phases 1a through 3 (`PRD.md` §10.3–§10.8) run unmodified: hard
placement of fixed activities, bounded backtracking for the required set,
greedy placement by priority with overlap nesting, sequence dependents
last, then assembly and diagnostics. The only difference downstream is
that "the frozen region" (used in invariant checks and in bounding where a
candidate start may fall) is simply the window's start, a plain input
value, rather than a quantity computed from `now` and lifecycle state.

Scoped re-solve (`PRD.md` §10.9) is subsumed entirely by the window itself
— there is no separate `SolveOptions.scope` argument to widen or narrow,
because the window already is the scope. "Replan the whole frame" is
"pass a window covering the whole span you care about"; "replan just the
rest of today" is "pass a window starting now." Both are the same
function call shape.

## 12. The function contract

### 12.1 Input

| Field | Shape | Notes |
| --- | --- | --- |
| Window | start instant, end instant, IANA timezone | Section 6. No `dayCount`; the day table is derived. |
| Default day window | optional wall-clock start/end | Section 6.3. Unchanged from `PRD.md` §6.2.2. |
| Activities | ordered list of entries | Each entry is either open or locked (Section 7); order determines the priority-ranking denominator (Section 11 step 2) and, for open entries, carries the same fields `PRD.md` §5.1's `Activity` describes (duration, priority rank, rules, `requiredCount`, enabled). |
| Cost constants | optional partial override | Unchanged (`PRD.md` §9, `DEFAULT_COST_CONSTANTS`). |

There is no `now`, no `existing`, no `carryIn`, no `prelude`, no `event`,
no `finalised`, and no `revision` anywhere in the input. Everything those
fields used to carry is now expressed through which activities are locked
and how (Section 7), and through the window itself (Section 6).

### 12.2 Output

| Field | Shape | Notes |
| --- | --- | --- |
| Placements | list of placed/locked/excluded/skipped entries | Each carries its identity, its resolved (or caller-supplied) start and end, and, where applicable, the relaxations applied to reach it — unchanged in substance from `PRD.md` §5.2's `TimelineActivity`, minus every lifecycle field (`state`, `actualStart`/`actualEnd`, `completedSource`, `spanningFromPreviousDay`, `locked`-as-a-lifecycle-artifact). `locked` remains, but now means exactly and only "the caller marked this entry locked on the way in" (Section 7). |
| Diagnostics | list of diagnostics | Unchanged shape (`PRD.md` §10.8: severity, code, instance ids, message). The event-rejection codes (`PRD.md` §11.9) are gone; the caller-exclusion code from Section 7.2 is new. |
| Cost | `CostBreakdown` | Unchanged (`PRD.md` §9.4). |
| Status | `OK` or `DEGRADED` | `REJECTED` is gone — there is no event for a result to be rejected relative to. `DEGRADED` keeps its existing meaning: the solve is fully returned, but at least one hard requirement could not be met. |

### 12.3 What the caller reconstructs, if it wants it

Nothing described above prevents a caller from layering its own notion of
revisions, history, or "what changed" on top of `solve()` — it simply
means that layer lives entirely in the caller's own store, built from
ordinary result comparison, rather than being a contract the engine
promises to maintain. A caller wanting `TICK`-style "did anything change"
behaviour compares two results for equality itself; a caller wanting
`RejectionError`-style previews runs `solve()` twice and diffs the
placements itself (Section 14 has the pattern for both).

## 13. Validation changes

`PRD.md` §12's catalogue validation (`validateActivity`, `validateCatalog`,
`validateSeparation`) is unchanged in full — none of it depended on the
event layer or the lifecycle.

`validateFrame` (`PRD.md` §12.4) is retitled to validate the window
instead: `FRAME_TOO_LONG` is replaced by a check that the window's span is
within whatever maximum the implementation still wants to bound the search
by; `FRAME_BACKDATE_HORIZON_INVALID` is deleted outright, because
`backdateHorizonMinutes` no longer exists; `FRAME_DEFAULT_WINDOW_INVALID`
is unchanged.

Deleted entirely, because the mechanism they validated is gone: every code
in `PRD.md` §11.9's rejection catalogue (`FIXED_COLLISION`-as-rejection,
`MANDATORY_UNPLACEABLE`, `STRICT_WINDOW_VIOLATED`, `GUEST_WINDOW_VIOLATED`,
`SEQUENCE_UNSATISFIABLE`, `SPANS_FROZEN_REGION`, `UNKNOWN_INSTANCE`,
`INVALID_STATE_FOR_EVENT`).

New: a diagnostic code identifying a locked-excluded entry in the output
(Section 7.2), so a caller can distinguish "I told it to drop this" from
every other skip reason already in `PRD.md`'s diagnostic vocabulary
(`NO_FREE_SPACE`, `WINDOW_UNSATISFIABLE`, `INFEASIBLE_HARD_CONSTRAINT`,
`HOST_SKIPPED`, etc. — all unchanged).

## 14. Cookbook: old events as caller patterns

For a reader migrating from the event layer, each former event becomes a
pattern for constructing the next call's activities list. None of these
require a new engine capability beyond Sections 6–8.

| Former event | v3 pattern |
| --- | --- |
| `GENERATE_DAY` | Call `solve()` with a window covering the day and every activity open. There is no separate "first call" concept — every call looks like this one. |
| `TICK` | Call `solve()` again with the same window and the same activities list. Nothing changes, because nothing about the input changed — no idempotence mechanism is needed for this to hold. |
| `SKIP` | Replace that activity's entry with a locked-excluded entry (Section 7.2) before calling again. |
| `RESTORE` | Stop passing the locked-excluded entry; pass the entry open again. |
| `FINISH_EARLY` | Replace that activity's entry with a locked-occupied entry (Section 7.2) whose end is the actual, earlier end time, then call again with the same window — the newly-free space is solved for like any other free space, with no separate "reuse the freed time" step. |
| `EXTEND` | Replace that activity's entry with a locked-occupied entry whose end is pushed out by the desired number of minutes, then call again. |
| `ADD_ADHOC` | Append a new open entry to the activities list at whatever position reflects its intended priority, then call again. |
| `EDIT_INSTANCE_RULES` | Change the rules on that entry directly in the activities list passed to this call (and every subsequent one, for as long as the override should apply). |
| `FINALISE_FRAME` / carry-in | Take the placement(s) whose span reaches past this window's end from the result, and construct tomorrow's locked-occupied entry from them, in tomorrow's window's coordinates (Section 8). |
| Rejection preview | Call `solve()` with today's activities list, then again with the proposed change, and compare the two placement lists. Anything newly skipped that wasn't skipped before is the caller's own definition of "this would make things worse" — the engine offers no built-in classification of that comparison (`PRD.md` §11.9's rejection-code catalogue is gone; Section 13). |

## 15. Migration

Every call site currently assembling `SolveInput` needs to change; nothing
about the rule vocabulary, the fluent activity builder (`PRD.md` §5.1), or
the cost constants needs to change. Concretely:

1. Replace `dayFrame`/`frame` + `SolveOptions.scope` with a single window
   argument (Section 6).
2. Replace `existing` + `carryIn` + `prelude` with one activities list
   where already-decided entries are marked locked (Sections 7–8). A
   caller currently computing lifecycle state from `now` needs to move
   that computation to its own side, using its own clock, and emit the
   locked form directly instead of relying on the engine to infer it.
3. Delete every `Event` construction at call sites; replace each with the
   corresponding pattern from Section 14.
4. Drop any code reading `Timeline.revision`, `Timeline.finalised`, or
   handling `RejectionError` — none of these are produced anymore.
5. Any persisted `TimelineActivity` record with lifecycle fields
   (`state`, `actualStart`/`actualEnd`, `completedSource`,
   `spanningFromPreviousDay`) needs those fields moved to whatever the
   caller's own store already tracks for a task (this is very likely a
   no-op, since a Turso-backed app already needs its own notion of "this
   task is done" independent of what the engine calls it). What the
   engine still needs from that record, on the next call, is only: is it
   locked, and if so, what span does it occupy (or is it excluded).

There is no stored-shape migration on the scale of `SPEC-v2.md` §6/§10.2's
occurrence-id rewrite — occurrence and instance identity (`PRD.md` §5.2)
are untouched by this document.

## 16. Out of scope

This document does not revisit:

- The rule vocabulary, the cost model, or any placement algorithm.
- Recurrence, expansion, or bucketing (`PRD.md` §7) — an activity's
  `RepeatRule` still produces multiple occurrences per window exactly as
  before; this document only changes how the window itself is expressed.
- The known gaps already recorded in `PRD.md` §13 (`computeTailroom` not
  wired up, the quota ledger not existing, `isGhostable`'s scope boundary,
  chunked-host sequence binding). None of them are caused by, or fixed by,
  this simplification; they remain open exactly as described there.
- Anything about storage, transport, or UI — unchanged from `PRD.md` §18:
  the engine remains a library with no opinion on any of it.

## 17. Acceptance criteria for this simplification

1. `solve()`'s input contains no field named `now`, `existing`, `carryIn`,
   `prelude`, `event`, `finalised`, or `revision`.
2. `solve()`'s output contains no `REJECTED` status and no
   `RejectionError`.
3. There is no lifecycle state anywhere in the placement output beyond
   "locked" (Section 7) and the placement itself.
4. For the single-call, whole-day, no-exclusions case (Section 2), every
   existing placement/cost/diagnostic assertion in the current test suite
   still holds against the v3 call shape, modulo the field deletions this
   document makes explicit.
5. A window not aligned to local midnight, with at least one locked-
   occupied entry whose span starts before the window and at least one
   open entry whose resolved placement ends after the window, is exercised
   by a dedicated test and produces the same placements as the equivalent
   two-frame `carryIn`/`prelude` scenario does today.
6. Every row in Section 14's cookbook has at least one test constructed
   exactly as that row describes, asserting the result matches what the
   corresponding pre-v3 event produced for the same scenario.
7. `solve()` called twice with byte-identical input produces byte-identical
   output, with no special-casing required to make that true (criterion
   for deleting the `TICK`-idempotence mechanism outright rather than
   keeping a vestige of it).
