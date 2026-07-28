# Dynamic Day Scheduler — Engine Specification, v2 **Drop 1**

**Status: behaviour-preserving refactor. No new scheduling behaviour.**

This document specifies **Drop 1 of v2**. It changes the shape of the rule
vocabulary, the identity scheme, the frame type, and the event layer. It
changes **no scheduling behaviour whatsoever**.

It is a companion to `SPEC.md`, not a replacement. Everything `SPEC.md`
says about the solver's phases, the cost model, the search, drift
arithmetic, overlap nesting, sequence chains, backdating, and rejection
remains authoritative and is deliberately not restated here. Where this
document is silent, `SPEC.md` governs.

Drop 2 — multi-day frames, real recurrence, frame chaining, scoped
re-solve — is scoped in Section 11 and is explicitly **not** part of this
drop.

---

## Table of contents

1. [Why this drop exists](#1-why-this-drop-exists)
2. [The acceptance criterion](#2-the-acceptance-criterion)
3. [Frame](#3-frame)
4. [The rule vocabulary](#4-the-rule-vocabulary)
5. [Required, not Mandatory](#5-required-not-mandatory)
6. [Identity: occurrences](#6-identity-occurrences)
7. [The event layer](#7-the-event-layer)
8. [Validation changes](#8-validation-changes)
9. [What does not change](#9-what-does-not-change)
10. [Migration](#10-migration)
11. [Out of scope — deferred to Drop 2](#11-out-of-scope--deferred-to-drop-2)
12. [Build order and acceptance](#12-build-order-and-acceptance)

---

## 1. Why this drop exists

Drop 2 introduces multi-day frames and recurrence. Doing that work against
the v1 vocabulary means writing it twice: seven rule types instead of five,
three window branches in the hottest predicate in the engine, seven
near-duplicate event handlers each needing its own scoped-re-solve change,
and an identity scheme (`instance.id === activity.id`) that cannot express
more than one instance of an activity.

Drop 1 pays that debt first, under conditions where correctness is cheap to
verify. Every change below is a *representation* change: each collapsed
case is exactly expressible in v1 semantics, so the existing test corpus is
the regression suite and needs (almost) no edits.

Four things are bought:

| Change | Buys |
| --- | --- |
| Window merge | One predicate instead of three; deletes a rule type, a validation code, and a hot-path branch. Drop 2's window-list generalisation becomes a one-line change. |
| Repeat merge | Chunking and recurrence become one mechanism at two levels. Drop 2 adds a boolean rather than a subsystem. |
| Occurrence ids | The only stored-shape migration in the whole of v2, done once instead of twice. |
| Event-layer collapse | Drop 2's scoped re-solve is implemented once instead of seven times. **This is the load-bearing one.** |

---

## 2. The acceptance criterion

> **The existing test suite passes with no changes to any assertion about
> placement, cost, status, diagnostics, or rejection.**

This is the definition of done for Drop 1, and it is stronger than it
sounds. A constraint solver's failure mode is not a crash; it is a schedule
that is quietly, subtly worse. The only defence is a corpus that fires on
change. Preserving it exactly is worth more than any amount of code review.

Three permitted exceptions, and no others:

1. **Fixture construction.** Tests build catalogues through the fluent
   builder (`.strict()`, `.flexible()`, `.mandatory()`, `.shrink()`). Those
   methods survive as sugar (Section 10.1), so most fixtures need no edit
   at all. Fixtures that hand-assemble a `Rule` literal must be rewritten.
2. **Instance ids in assertions.** Section 6 changes `instance.id`. Any
   test asserting `"gym"` or `"gym#2"` must be updated. `expectPlacements`
   keys on name and `renderAscii` prints names, so this should be a small
   set — but it is the one place the criterion above genuinely bends, and
   any such edit must be a *mechanical* id rewrite, never a change to an
   expected start, end, duration, status, or reason.
3. **Validation codes.** Three codes are renamed (Section 8). Tests
   asserting on those codes change the code string and nothing else.

If a placement moves, a cost changes, or a status flips, **the drop is
wrong**. Do not update the snapshot. Find the semantic difference.

---

## 3. Frame

`DayFrame` becomes `Frame`. In Drop 1, `dayCount` is always `1`.

```
Frame {
  startDate      : "YYYY-MM-DD"    // local calendar date of day 0
  timezone       : IANA zone
  startInstant   : UTC ms of local 00:00 on startDate
  dayCount       : int             // ALWAYS 1 in Drop 1
  lengthMinutes  : int             // Σ days[].lengthMinutes
  days           : Day[]           // exactly one entry in Drop 1
}

Day {
  index          : int             // 0-based
  date           : "YYYY-MM-DD"
  weekday        : Weekday
  startOffset    : int             // minutes from frame start to this day's local 00:00
  lengthMinutes  : int             // 1440 / 1380 / 1500
}
```

**Invariant: a frame always starts at local midnight.** This is what makes
the day table trivial to build and keeps wall-clock resolution honest
across DST. Do not relax it.

`days[0]` is built exactly as `resolveDayFrame` builds a `DayFrame` today —
local midnight to local midnight, sampled from the timezone database. All
of `time.ts`'s DST logic is unchanged; it is simply called once per day
instead of once per frame.

### 3.1 Wall-clock resolution

```
resolveWallClock(wall, frame, dayIndex) → offset
    = frame.days[dayIndex].startOffset + withinDay(wall, frame.days[dayIndex])
```

`withinDay` is today's `resolveWallClock` verbatim, including the
spring-forward-gap binary search and the fall-back first-occurrence rule
(`SPEC.md` §3.3). With `dayIndex = 0` and `startOffset = 0` this is
arithmetically identical to today.

### 3.2 Compatibility

`resolveDayFrame(date, timezone)` is retained and returns
`resolveFrame(date, 1, timezone)`. Callers need not change.

`Frame.date` is exposed as a getter aliasing `startDate`, and
`Frame.lengthMinutes` behaves as before, so `SolveInput.dayFrame` keeps its
name and its field access. **Renaming `dayFrame` to `frame` is deferred to
Drop 2** — it touches every call site for no behavioural gain, and Drop 2
has to touch them anyway.

---

## 4. The rule vocabulary

Seven types become six, and one becomes a field.

| v1 | Drop 1 |
| --- | --- |
| `FixedRule` | `FixedRule` — unchanged (see 4.5) |
| `StrictWindowRule` | `WindowRule` with `maxDriftMinutes: 0` |
| `FlexibleWindowRule` | `WindowRule` |
| `Activity.allowedDays` | `WindowRule.days` |
| `MandatoryRule` | `Activity.requiredCount` (Section 5) |
| `ShrinkRule.minDuration` / `.minChunk` | `ElasticityRule` |
| `ShrinkRule.chunkingAllowed` / `.maxChunks` | `RepeatRule` with `sharedBudget: true` |
| `SequenceRule` | unchanged |
| `OverlapRule` | unchanged |

### 4.1 WindowRule

```
WindowRule {
  type             : "window"
  source           : "template" | "instance"
  days             : Weekday[]      // days this window applies on
  startWall        : "HH:MM"
  endWall          : "HH:MM"        // ≤ startWall means the window spans midnight
  maxDriftMinutes  : int            // 0 = strict
}
```

**A strict window is a flexible window with zero drift.** "Placed entirely
inside the window" and "minutes outside the window ≤ 0" are the same
predicate. This is not an approximation; it is an identity, and it is why
this merge is safe.

**`allowedDays` is a window, not a filter.** An activity's eligible region
is the union of its windows; a day not named by any window is a day the
activity cannot be placed on. In Drop 1 there is one day, so this is a
no-op — but expressing day-eligibility as a window is precisely what lets
Drop 2 generalise without a second mechanism.

Semantics, unchanged from `SPEC.md` §5.3:

- Drift is **minutes of the activity lying outside the window**, summed
  across both sides, each side capped so a candidate lying wholly on one
  side is not double-counted past its own duration.
- A candidate is feasible iff its drift ≤ `maxDriftMinutes`.
- Under chunking, drift sums across all blocks against the single
  allowance.

**An activity may carry more than one `WindowRule.`** This is the sole
exception to "at most one rule of each type," and it is a capability gain
that costs nothing: `ResolvedActivity` already needs to hold a list for
Drop 2. Multiple windows union, and drift is the **minimum** over windows:

```
drift(candidate) = min over w in windows of driftAgainst(candidate, w)
feasible          = ∃ w : driftAgainst(candidate, w) ≤ w.maxDriftMinutes
```

With one window this is arithmetically identical to today.

**Absence of a `WindowRule`** means an implicit window: every weekday, the
full span of the day, `maxDriftMinutes: 0`. A fully floating activity is
therefore represented, not special-cased — the "no window rule at all"
branch in `evaluateCandidate` disappears.

**Drift may not soften day-eligibility.** A candidate must lie within the
union of its windows' *day spans* regardless of drift allowance. In Drop 1
this is unreachable (one day, and the frame bounds it), but the check is
specified and implemented now because Drop 2 makes it reachable and a
missing containment check there is a silent correctness bug.

### 4.2 RepeatRule

```
RepeatRule {
  type          : "repeat"
  source        : "template" | "instance"
  period        : "day" | "week" | "month" | "frame"   // Drop 1: must be "day"
  count         : int ≥ 1
  sharedBudget  : bool                                  // Drop 1: must be true
  minSeparationMinutes : int                            // Drop 1: must be 0
}
```

`sharedBudget` is the entire difference between chunking and recurrence:

- **`true`** — the `count` blocks draw on **one** duration budget. An extra
  block therefore buys nothing and costs `CHUNK`, so the solver minimises
  the block count on its own. This is chunking.
- **`false`** — each block carries its **own** full duration. A missing
  block costs `W × SKIP`, so the solver maximises the block count up to
  `count`. This is recurrence.

You never declare the direction of preference. It falls out of the existing
cost constants once you say whether the budget is shared. This is why the
two features are one rule and not two.

**Drop 1 permits only `sharedBudget: true`, `period: "day"`,
`minSeparationMinutes: 0`.** Any other value is a validation error
(`NOT_YET_SUPPORTED`). The fields exist now so that Drop 2 adds no type
churn and no stored-shape migration.

Mapping from v1: `chunkingAllowed: true, maxChunks: N` becomes
`RepeatRule { period: "day", count: N, sharedBudget: true }`.
`chunkingAllowed: false` becomes **no `RepeatRule`**.

Semantics of a shared-budget repeat are `SPEC.md` §5.5 and §8.6 step 5
verbatim: blocks may sum to the full duration or to less; a plan is legal
whenever its total clears `ElasticityRule.minTotalMinutes`; one unsplit
block at full duration is the zero-cost baseline; ties favour the
single-block result.

### 4.3 ElasticityRule

```
ElasticityRule {
  type             : "elasticity"
  source           : "template" | "instance"
  minTotalMinutes  : int    // hard floor on total scheduled time (v1: minDurationMinutes)
  minBlockMinutes  : int    // hard floor on any single block  (v1: minChunkMinutes)
}
```

`minBlockMinutes ≤ minTotalMinutes ≤ durationMinutes` must hold.

Without an `ElasticityRule` an activity is all-or-nothing: full duration or
skipped, exactly as today. Defaults when the rule is absent but a
`RepeatRule` is present: `minTotalMinutes = durationMinutes`,
`minBlockMinutes = GRID` — i.e. split freely, but do not shorten. This
combination is newly expressible and is harmless; no v1 catalogue produces
it.

### 4.4 The two levels

`RepeatRule` is one operation applied at two levels:

```
Activity   ──Repeat(sharedBudget: false)──▶  Occurrences
Occurrence ──Repeat(sharedBudget: true) ──▶  Blocks
```

An activity may carry **at most one `RepeatRule` of each `sharedBudget`
value**. Drop 1 permits only the second level. Do not allow the
construction to recurse beyond two levels; the grouping structure that
makes budgets meaningful does not survive a third.

### 4.5 FixedRule stays

`FixedRule` is a window whose length equals the activity's duration with
zero drift — exactly one feasible candidate — and the hard set already
orders most-constrained-first, so a merged fixed rule would sort to the
front on its own and Phase 1a would disappear.

**It is nonetheless excluded from Drop 1, because merging it changes
behaviour.** Today, two colliding fixed activities are *both* marked
infeasible with a blocking diagnostic naming both (`SPEC.md` §11 case 6,
`ALGORITHM.md` §6: "the engine never picks an arbitrary winner"). Routed
through the hard set, backtracking would place one and skip the other. That
is a different result, and Section 2 forbids it.

The merge is recoverable — detect "zero-slack activity skipped by collision
with another zero-slack activity" and re-emit the paired diagnostic — but
re-implementing Phase 1a inside the hard set buys nothing in this drop.
Revisit after Drop 2.

### 4.6 Compatibility matrix

|                | Fixed | Window | Repeat | Elasticity | Sequence | Overlap |
| -------------- | ----- | ------ | ------ | ---------- | -------- | ------- |
| **Fixed**      | —     | ✗      | ✗      | ✗          | ✓        | ✓       |
| **Window**     | ✗     | (many) | ✓      | ✓          | ✓        | ✓       |
| **Repeat**     | ✗     | ✓      | —      | ✓          | ✓        | ✓       |
| **Elasticity** | ✗     | ✓      | ✓      | —          | ✓        | ✓       |
| **Sequence**   | ✓     | ✓      | ✓      | ✓          | —        | ✓       |
| **Overlap**    | ✓     | ✓      | ✓      | ✓          | ✓        | —       |

The v1 matrix's `Strict ✗ Flex` mutual exclusion is gone — they are the
same rule, and multiple windows are now legal. `Fixed ✗ Repeat` is new in
name only: v1's `Fixed ✗ Shrink` already forbade it.

---

## 5. Required, not Mandatory

`MandatoryRule` is a fields-less marker whose only effects are
`skipCost = ∞` and hard-set membership — and the second is derivable from
the first. It becomes a field:

```
Activity.requiredCount : int    // default 0. Drop 1: 0 or 1.
```

- `0` — discretionary. Skipping costs `W × SKIP`.
- `1` — exactly v1's `MandatoryRule`. Skipping costs `∞`; the activity is
  placed in the hard set with bounded backtracking.

The name is deliberate. In Drop 2, `requiredCount` becomes the count of
occurrences that must be placed: occurrences with `index < requiredCount`
carry infinite skip cost, the rest do not. "Gym at least twice a week,
ideally three times" is then `count: 3, requiredCount: 2` with no new
machinery. The field is introduced now so that no stored shape changes
twice.

### 5.1 Hard-set membership

```
isHardConstrained(activity) = hasFixedRule(activity) || activity.requiredCount > 0
```

**Note a spec/implementation divergence resolved here.** `SPEC.md` §8.4
says the hard set includes `StrictWindowRule` activities. The
implementation does not — `runPipeline` builds the hard set from
`hasFixed` and `hasMandatory` only, and strict-window activities go to the
greedy pass. Drop 1 preserves **the implementation**, because Section 2
requires it, and corrects `SPEC.md` §8.4 to match. Under the window merge
there is no longer a "strict window" type to test for anyway; Drop 2
replaces this predicate with slack-based ordering, which subsumes the
spec's original intent properly.

### 5.2 Cost

`skipCost` (`cost.ts`) takes `isRequired` in place of `isMandatory`:

```
skipCost(weight, constants, { isRequired, isDependentSkip }) =
    isDependentSkip ? 0
  : isRequired      ? ∞
  :                   weight × SKIP
```

where `isRequired = occurrenceIndex < activity.requiredCount`. In Drop 1,
`occurrenceIndex` is always `0`, so this is `requiredCount > 0` — identical
to today.

---

## 6. Identity: occurrences

This is the only change in Drop 1 that alters a persisted shape, and it is
here rather than in Drop 2 specifically so that it happens **once**.

Today `freshInstance` sets `id = activity.id`, and chunks get
`${activity.id}#${n}`. Neither can express more than one instance of an
activity. Both change now.

### 6.1 The scheme

```
occurrenceId  = "{activityId}@{bucketKey}#{index}"
instanceId    = occurrenceId                    // single-block
              | "{occurrenceId}~{blockIndex}"   // one per block of a repeat plan
```

- `bucketKey` is the repeat period's key. In Drop 1, `period` is always
  `"day"` and `dayCount` is `1`, so `bucketKey` is always the frame's
  `startDate`.
- `index` is 1-based within the bucket. In Drop 1 it is always `1`.
- `blockIndex` is 1-based, ordered by start time.

Example: `gym@2026-07-28#1`, and its two blocks
`gym@2026-07-28#1~1`, `gym@2026-07-28#1~2`.

**Ad-hoc instances** keep the existing deterministic derivation (id from
the count of ad-hoc activities already present), wrapped in the same shape:
`adhoc-2@2026-07-28#1`. No clock read, no random source.

**Determinism.** Ids are a pure function of activity id, bucket key, and
index — no counters, no ordering dependence, no clock. Two identical solves
produce identical ids, as `SPEC.md` §16.3 criterion 6 requires.

### 6.2 Keying changes

Three places key on `activityId` today and must key on `occurrenceId`:

| Site | Today | Drop 1 |
| --- | --- | --- |
| `TimelineActivity.chunkGroupId` | `activity.id` | the `occurrenceId` |
| `extractAnchors` / `groupKeyOf` | `activityId ?? id` | `occurrenceId` |
| `checkEventRejection` before/after matching | `activityId` | `occurrenceId` |

Each is a latent Drop 2 bug being fixed early:

- **`chunkGroupId`** — with recurrence, two occurrences of one activity
  would otherwise share a group key, and `scheduleCost` would merge them
  into one bogus block plan, charging one shrink shortfall for two
  independent sessions.
- **`groupKeyOf`** — anchoring one occurrence would otherwise exclude
  *every* occurrence of that activity from re-solving. This is the single
  most likely source of a subtle v2 bug.
- **`checkEventRejection`** — matching by activity id would let "occurrence
  1 is still placed" mask "occurrence 2 became skipped," silently
  suppressing a `MANDATORY_UNPLACEABLE` rejection.

In Drop 1 all three are behaviourally identical, because there is exactly
one occurrence per activity and `occurrenceId` is in bijection with
`activityId`. That is exactly why now is the cheap time to change them.

### 6.3 New instance fields

```
TimelineActivity {
  ...
  occurrenceId    : string     // the occurrence this block belongs to
  occurrenceIndex : int        // 1-based within its bucket; always 1 in Drop 1
  bucketKey       : string     // always the frame's startDate in Drop 1
  blockIndex      : int        // was chunkIndex
  blockCount      : int        // was chunkCount
}
```

`chunkIndex` / `chunkCount` are renamed to `blockIndex` / `blockCount` for
consistency with `RepeatRule`; `chunkGroupId` is retained as a name
(its value is now `occurrenceId`) to keep the diff small. `date` is
retained, derived from `frame.days[dayIndex].date`.

---

## 7. The event layer

`ALGORITHM.md` §14 already names the problem: the handlers are
*"implemented separately (and largely duplicated) per event rather than
through one shared generic step."* Seven handlers span roughly 700 lines
of `solve.ts`, of which steps 3–7 are near-identical.

Drop 2 needs to change those shared steps — scoped re-solve touches every
one of them. Collapsing first means implementing it once.

### 7.1 The contract

Every event reduces to one pure function producing a plan, plus one shared
executor:

```
EventPlan {
  rejection        : RejectionError | null   // precondition failure, short-circuits
  workingExisting  : TimelineActivity[]      // `existing` with the event applied
  freezeBoundary   : int                     // ordinarily now; `at` for FINISH_EARLY
  extraActivities  : Activity[]              // ADD_ADHOC's pseudo-activity
  checkRejection   : bool                    // false for GENERATE_DAY/TICK/SKIP/FINISH_EARLY
}

planEvent(input, event, constants) → EventPlan          // per-event; the only per-event code
runEvent(input, plan, constants)   → SolveResult        // shared; the pipeline, once
```

`runEvent` performs, in order, exactly the steps `ALGORITHM.md` §14 lists
as 4–7:

1. `extractAnchors(plan.workingExisting)`
2. filter today's catalogue to non-anchored activities, plus
   `plan.extraActivities`
3. `runPipeline(...)` at `plan.freezeBoundary`
4. assemble anchors + solved instances, recompute cost and diagnostics,
   advance revision
5. if `plan.checkRejection`, run `checkEventRejection(before, after)` and
   discard the speculative result on a genuine regression

### 7.2 Per-event plans

Every handler shrinks to its preconditions and its mutation. Semantics are
`SPEC.md` §9 and `ALGORITHM.md` §14 verbatim — nothing below is new.

| Event | Precondition | Mutation | freezeBoundary | Reject |
| --- | --- | --- | --- | --- |
| `GENERATE_DAY` | — | none | `now` | no |
| `TICK` | — | auto-start / auto-complete / backdate; **short-circuit unchanged if nothing changed state, revision included** | `now` | no |
| `SKIP` | target `PLANNED` | mark `SKIPPED`, `locked: true`, reason `USER_SKIPPED` | `now` | no |
| `RESTORE` | target `SKIPPED` | clear `locked` | `now` | yes |
| `FINISH_EARLY` | target `ACTIVE`; `actualStart ≤ at ≤ plannedEnd` | mark `COMPLETED`, `actualEnd = at`, `completedSource: user` | `at` | no |
| `EXTEND` | target `ACTIVE`; `minutes > 0`, grid-aligned | `plannedEnd += minutes` | `now` | yes |
| `ADD_ADHOC` | payload validates as an activity | append instance + pseudo-activity; recompute `totalRanked` | `now` | yes |
| `EDIT_INSTANCE_RULES` | target exists | substitute rules tagged `source: "instance"`; patch the anchor in place if anchored | `now` | yes |

`FINALISE_DAY` keeps its separate short path (`ALGORITHM.md` §16) and does
not go through `planEvent`. It never touches the placement pipeline.

### 7.3 Invariants the collapse must preserve

These are the behaviours most likely to be lost in a refactor of this
shape. Each already has, or must gain, a dedicated test.

1. **`TICK` idempotence.** If no instance changed state, return the input
   timeline byte-identical **including its revision**. The short-circuit
   must live in `planEvent` for `TICK`, before `runEvent` is entered.
2. **Instance-rule-override durability.** `applyInstanceRuleOverrides` runs
   in shared setup before dispatch, unconditionally, for every event — not
   inside `EDIT_INSTANCE_RULES`. `SPEC.md` §9.6 calls this "the single most
   commonly broken behaviour in this spec." Keep its dedicated test:
   solve, override, solve, solve, assert the override survived all three.
3. **`ADD_ADHOC`'s `totalRanked` recomputation.** Adding an activity
   changes the priority-weight denominator for that solve only
   (`ALGORITHM.md` §14). This must not be lost to the shared path.
4. **`SKIP` locking.** The skip must set `locked: true` so
   `extractAnchors` keeps honouring it across later `TICK`s.
5. **Rejection purity.** A rejected solve returns a timeline deeply equal
   to its input, with the original revision and cost recomputed against the
   *unchanged* instances.
6. **Input immutability.** `runEvent` operates on copies. Deep-freeze the
   input in tests and assert it is unchanged after every solve, including
   after a rejection.

---

## 8. Validation changes

### 8.1 Renamed codes

| v1 | Drop 1 | Condition |
| --- | --- | --- |
| `SHRINK_FLOOR_INVALID` | `ELASTICITY_INVALID` | `minTotal > duration`, or `minBlock > minTotal` |
| `WINDOW_INVERTED` | `WINDOW_INVERTED` | unchanged; a non-spanning window with `end ≤ start` |
| `NO_ALLOWED_DAYS` (warning) | `NO_ELIGIBLE_DAYS` (warning) | the union of window `days` is empty |

### 8.2 New codes

| Code | Severity | Condition |
| --- | --- | --- |
| `NOT_YET_SUPPORTED` | error | `RepeatRule` with `sharedBudget: false`, `period ≠ "day"`, or `minSeparationMinutes ≠ 0` |
| `REPEAT_DUPLICATE` | error | Two `RepeatRule`s with the same `sharedBudget` value |
| `REQUIRED_COUNT_INVALID` | error | `requiredCount < 0`, or `> 1` in Drop 1 |

### 8.3 Unchanged

`RULE_INCOMPATIBLE`, `DURATION_NOT_ON_GRID`, `SEQUENCE_CYCLE`,
`SEQUENCE_MULTIPLE`, `PRIORITY_DUPLICATE`, `DOMINANCE_VIOLATION`,
`WINDOW_TOO_SHORT`, `DRIFT_UNAVOIDABLE`, `GUEST_OUTRANKS_HOST`.

The dominance invariant (`SPEC.md` §7.4) is restated in the new vocabulary
with identical arithmetic:

```
SKIP  >  SHRINK × (durationMinutes − minTotalMinutes)
       + CHUNK  × (repeat.count − 1)
       + DRIFT  × max over windows of maxDriftMinutes
       + GAP    × sequence.maxGapMinutes
```

Terms for absent rules are zero. Give it its own unit test with a
deliberately broken activity: when this invariant fails the symptom is not
a crash but a solver that quietly starts discarding work.

---

## 9. What does not change

Stated explicitly, because the value of this drop depends on the blast
radius staying small.

**Untouched files:** `intervals.ts`, `render.ts`, `constants.ts`,
`lifecycle.ts`, `greedy.ts`, `overlap.ts`, `hard-set.ts`, `sequence.ts`.

**Near-untouched:** `cost.ts` (the `isMandatory → isRequired` rename and
the `chunkGroupId` value change; no formula moves), `placement.ts`
(unchanged; it consumes free intervals and a resolved activity, and neither
contract changes), `shrink.ts` (reads its parameters from `RepeatRule` +
`ElasticityRule` instead of `ShrinkRule`; the search is identical),
`time.ts` (gains `resolveFrame` and a `dayIndex` parameter; the DST logic
is unchanged).

**Real work:** `types.ts`, `validation.ts`, `resolve.ts` (window list +
min-over-windows), `activity-builder.ts` (sugar preserved), `solve.ts` (the
event collapse and the id scheme).

**Unchanged behaviour, in full:** the phase order (fixed → hard set →
greedy → sequence); the cost formula and all constants; drift arithmetic;
the tie-break chain; bounded backtracking and its node limit; overlap
nesting, budgets, and exclusion windows; sequence rounds, chains, and free
dependent-skip; backdating, auto-start, auto-complete; the freeze boundary;
rejection codes and their before/after comparison; `DEGRADED` vs
`REJECTED`; carry-in and `FINALISE_DAY`; `renderAscii` output.

**Purity obligations** (`SPEC.md` §12.2) are unchanged and non-negotiable:
no clock read below `solve`, no input mutation, no unordered iteration, no
exceptions for expected outcomes, no logging, all configuration by
argument.

---

## 10. Migration

### 10.1 Builder sugar — the compatibility layer

The fluent builder absorbs the whole rule change. These all survive with
identical signatures:

| Builder call | Emits in Drop 1 |
| --- | --- |
| `.strict(start, end)` | `WindowRule { days: allowedDays, start, end, maxDriftMinutes: 0 }` |
| `.flexible(start, end, {drift})` | `WindowRule { days: allowedDays, start, end, maxDriftMinutes: drift }` |
| `.days(...d)` | sets `days` on every window (and the implicit one) |
| `.mandatory()` | `requiredCount = 1` |
| `.shrink({floor, chunking, minChunk, maxChunks})` | `ElasticityRule { minTotalMinutes: floor, minBlockMinutes: minChunk }` + `RepeatRule { period: "day", count: maxChunks, sharedBudget: true }` when `chunking` |
| `.fixed(start, end)` | `FixedRule` — unchanged |
| `.sequence(...)`, `.overlap(...)` | unchanged |

New calls: `.window(start, end, {drift, days})` (repeatable),
`.required(n)`, `.elastic({minTotal, minBlock})`, `.repeat({count})`.

Because `app/brain/engine/*` is already declared implementation detail
(`API.md`, "What's deliberately not exported"), the `Rule` union changing
shape is not a public break. Only catalogues that hand-assemble rule
literals need rewriting.

### 10.2 Stored state

`TimelineActivity.id` changes value. Any persisted timeline needs a
one-time rewrite:

```
id: "gym"        → "gym@{frame.startDate}#1"
id: "gym#2"      → "gym@{frame.startDate}#1~2"
chunkGroupId: "gym" → "gym@{frame.startDate}#1"
```

The rewrite is total and mechanical: every v1 instance has exactly one
occurrence, and `date` supplies the bucket key. Any caller-held
`instanceId` (an in-flight event, a UI selection) must be remapped the same
way.

**This is the only stored-shape migration in v2.** Doing it now rather than
in Drop 2 avoids a second, far nastier one — a 1→N split, where a single
stored id has no unambiguous successor.

---

## 11. Out of scope — deferred to Drop 2

Named here so the boundary is unambiguous, and because several fields above
exist only to serve them.

- `dayCount > 1`. Multi-day frames, per-day window expansion, the death of
  midnight as a special case, spanning windows, and the deletion of
  `CARRIED_IN` / `spanningFromPreviousDay` / `Timeline.carryIn`.
- `RepeatRule` with `sharedBudget: false` — real recurrence, N occurrences
  per bucket.
- `period` beyond `"day"`; the expansion pre-pass and bucket partitioning.
- `minSeparationMinutes`, and per-occurrence-group bounded backtracking.
- `requiredCount > 1`.
- `prelude`, frame chaining, and the cross-frame quota ledger.
- Scoped re-solve and scoped rejection checking.
- Hard-set decomposition into connected components.
- `Frame.defaultDayWindow`.
- Per-day resolution of absolute-anchored exclusion windows.
- Sequence recurrence induction (one dependent occurrence per host
  occurrence).
- Merging `FixedRule` into `WindowRule` and deleting Phase 1a.
- Renaming `SolveInput.dayFrame` to `frame`.

---

## 12. Build order and acceptance

Each step ends with the full existing suite green. Do not proceed past a
red step.

| # | Step | Done when |
| --- | --- | --- |
| 1 | `Frame` + day table; `resolveDayFrame` as an alias; `resolveWallClock(wall, frame, 0)` | Suite green, zero test edits. DST tests (1380/1440/1500) pass through the day table. |
| 2 | `WindowRule` + min-over-windows in `resolveActivity` / `evaluateCandidate`; `allowedDays` → `days`; builder sugar | Suite green. §5.3's drift table passes verbatim against the merged predicate. |
| 3 | `requiredCount`; `isRequired` in `skipCost`; `isHardConstrained` | Suite green. Every mandatory test passes untouched. |
| 4 | `ElasticityRule` + `RepeatRule(sharedBudget: true)`; `shrink.ts` reads the new fields | Suite green. Worked examples 14.2, 14.6, 14.6b pass with unchanged snapshots. |
| 5 | Occurrence id scheme; the three keying changes; migration helper | Suite green modulo **mechanical id rewrites only** (Section 2, exception 2). |
| 6 | `planEvent` / `runEvent` collapse | Suite green. All six §7.3 invariants have a dedicated passing test. |
| 7 | Validation: renamed and new codes | Every code in Section 8 is reached by at least one test. |

### 12.1 Acceptance criteria for Drop 1

1. **No assertion about placement, cost, status, diagnostics, or rejection
   changes anywhere in the suite.** Permitted edits are limited to Section
   2's three exceptions.
2. All eight worked examples (`SPEC.md` §14) pass with **byte-identical
   committed snapshots**, modulo instance ids.
3. All twenty-three edge cases (`SPEC.md` §11) pass unchanged.
4. Every property in `SPEC.md` §16.1 layer 5 still holds over ≥ 1,000
   generated cases — determinism, input immutability, no overlap, shrink
   floor, mandatory, cost monotonicity, tick idempotence, rejection purity.
5. `checkInvariants` runs on every result produced anywhere in the suite
   and never fires.
6. A full solve of a 20-activity day still completes in under 100 ms.
7. `solve.ts` is materially shorter than its v1 1,786 lines. If it is not,
   the event collapse did not actually collapse anything.
8. A **new** differential test: for a corpus of catalogues expressed both
   ways, `solve(v1Catalog)` and `solve(migrate(v1Catalog))` produce deeply
   equal timelines modulo ids. This is the cheapest possible proof of
   Section 2 and is worth building before step 2 rather than after step 7.

Criterion 8 is the one to build first. Everything else in this document is
a claim about equivalence; that test is the only thing that checks it.