# `@balanced/brain` — Product Requirements Document

**Scope:** `packages/brain` — the Dynamic Day Scheduler engine. A pure,
framework-agnostic TypeScript library that turns a catalogue of recurring
activity templates plus a stream of events into a concrete, minute-resolution
schedule.

**Status of this document:** consolidated from the current implementation
(`src/engine/*`, `src/brain.ts`) as of this writing, cross-checked against
`SPEC.md` (v1), `SPEC-v2.md` ("Drop 1"), `SPEC-v2.1.md` ("Drop 2"),
`ALGORITHM.md`, and `API.md`. **Where the prior documents and the code
disagree, this document follows the code** and calls the discrepancy out
explicitly in [§13](#13-known-gaps-and-speccode-divergences). Treat the four
prior documents as historical design records, not as a reliable description
of current behavior — several of them predate features the code now has, and
`API.md` in particular documents a pre-"Drop 1" surface that no longer
exists.

---

## Table of contents

1. [Purpose and problem statement](#1-purpose-and-problem-statement)
2. [Design tenets](#2-design-tenets)
3. [Glossary](#3-glossary)
4. [Time model](#4-time-model)
5. [Domain model](#5-domain-model)
6. [Rule reference](#6-rule-reference)
7. [Recurrence and expansion](#7-recurrence-and-expansion)
8. [Lifecycle and states](#8-lifecycle-and-states)
9. [Cost model](#9-cost-model)
10. [The solver pipeline](#10-the-solver-pipeline)
11. [The event layer](#11-the-event-layer)
12. [Validation](#12-validation)
13. [Known gaps and spec/code divergences](#13-known-gaps-and-speccode-divergences)
14. [Public API surface](#14-public-api-surface)
15. [Non-functional requirements](#15-non-functional-requirements)
16. [Structural invariants](#16-structural-invariants)
17. [Test coverage map](#17-test-coverage-map)
18. [Out of scope](#18-out-of-scope)

---

## 1. Purpose and problem statement

A person has a set of recurring things they do — work, commute, gym, study,
reading, chores — each with a duration, a preferred or required time of day,
and a relative importance. A static calendar breaks the moment reality
diverges: a meeting overruns, a task finishes early, an urgent errand
appears. Fixing the rest of the day by hand is tedious, and the person
abandons the plan.

The engine solves this by never patching a schedule — it **recomputes the
remainder of the day (or the remainder of the current bucket, for a
multi-day frame) from scratch, every time anything changes.** The user
defines activity templates once, each carrying typed rules describing when
it may be placed, how hard that requirement is, whether it can be shortened,
whether it may overlap other activities, and what it must sit adjacent to. A
single pure function, `solve()`, turns a catalogue plus one `Event` into a
new timeline.

The engine is a **library**, not an application. It knows nothing about
storage, transport, processes, or UI. Its entire contact with the outside
world is one function call in and one value out
(`solve(SolveInput) → SolveResult`). Everything about how templates are
persisted, how a result is rendered, or when `solve` gets called is the
concern of the embedding app (`apps/web`, and eventually `apps/api`).

### 1.1 What "the best schedule" means

The solver has no taste. It minimizes a numeric **cost function**
([§9](#9-cost-model)). Every compromise — shortening an activity, splitting
it into chunks, drifting it outside its preferred hours, dropping it
entirely — has a defined price, and the cheapest legal schedule wins. Tuning
behavior means changing a weight, not changing the algorithm.

---

## 2. Design tenets

These four properties are enforced by the current implementation and are
non-negotiable — every other requirement in this document assumes them:

1. **`solve()` is one pure function.** `(SolveInput) → SolveResult`. No
   internal clock read, no I/O, no randomness, no ambient state. Identical
   input yields byte-identical output.
2. **Every change is a full re-solve of the affected region.** There is no
   incremental patching. The affected region is, by default, "the rest of
   the day frame's current calendar day" — see
   [§10.9](#109-scoped-re-solve) for the multi-day generalization.
3. **Time is an argument, never a reading.** `now` is passed in on every
   call. Nothing under `src/engine/` calls `Date.now()` or
   `new Date()` with no arguments.
4. **The result explains itself.** Every compromise the solver makes emits a
   diagnostic (`Timeline.diagnostics`). A caller never has to
   reverse-engineer why a block moved.

---

## 3. Glossary

| Term | Meaning |
| --- | --- |
| **Activity** | A reusable, global template (`Gym`, `Work`, `Reading`). Never appears on a timeline directly. |
| **Rule** | A typed constraint attached to an `Activity` or a `TimelineActivity`. |
| **Occurrence** | One expected instance of an activity within one recurrence bucket — the solver's actual unit of work since recurrence landed. Degenerates to "one per activity per day" when the activity has no `RepeatRule`. |
| **TimelineActivity** ("instance") | A concrete instance of an occurrence placed (or attempted) on the timeline. Carries its own deep copy of the rules. |
| **Timeline** | The ordered set of `TimelineActivity`s for one `Frame`, plus diagnostics, cost, and status. |
| **Frame** (`DayFrame` is an alias) | The wall-clock window being solved: one or more consecutive local calendar days, with timezone and true per-day length in minutes. |
| **Bucket** | A recurrence rule's period sliced against the frame (`day`, `week`, `month`, or `frame`); the unit that `RepeatRule.count` counts within. |
| **Placement** | A concrete `(start, end)` assignment for a `TimelineActivity`, in frame-relative minute offsets. |
| **Anchor** | A block the current solve may not move: `ACTIVE`, `COMPLETED`, `CARRIED_IN`, or explicitly `locked`. |
| **Host / Guest** | In an overlap relationship, the host is the containing activity; the guest is nested inside it. |
| **Exclusion window** | A named sub-region of a host during which no guest may be placed. |
| **Relaxation** | A compromise applied to fit an activity: `shrink`, `chunk`, `drift`, or `gap`. |
| **Free interval** | A maximal stretch of the frame not occupied by any top-level (non-guest) block. |
| **Ghosting** | The mechanism (`isGhostable`) that lets an ordinary recurring activity get one real `Occurrence` per eligible bucket, while an activity involved in `Overlap`/`Sequence` cross-references keeps single-instance-per-frame behavior until that rekeying work lands (§13.6). |
| **Speculative solve** | A solve run to test whether a proposed user action is legal, whose result is discarded on rejection. |

---

## 4. Time model

### 4.1 Units and resolution

- All internal time arithmetic uses **integer minutes**, as offsets from the
  start of the `Frame` (`0` = the first minute of day 0). No wall-clock
  strings or timestamps flow through solver logic.
- **Grid resolution is `GRID = 5` minutes** (`src/engine/constants.ts`).
  Every duration, window boundary, and placement start must be a multiple of
  `GRID`; non-conforming values are rejected at validation time
  (`DURATION_NOT_ON_GRID`). This bounds the search space to at most 288
  candidate starts per day.
  - **Divergence from `API.md`:** that document states the default `GRID`
    is `15`. The code's actual default (`DEFAULT_COST_CONSTANTS.GRID`) is
    `5`. Code is authoritative; `API.md` is stale here.

### 4.2 Frame

```
Frame {
  startDate      : "YYYY-MM-DD"   // local calendar date of day 0
  date           : "YYYY-MM-DD"   // alias of startDate
  timezone       : IANA zone, e.g. "Europe/Berlin"
  startInstant   : UTC epoch ms of local 00:00 on startDate
  dayCount       : int, >= 1, capped at 366 (FRAME_TOO_LONG)
  lengthMinutes  : sum of days[].lengthMinutes
  days           : Day[]          // dayCount entries
  defaultDayWindow? : { startWall, endWall }
  backdateHorizonMinutes? : int
}

Day {
  index          : int    // 0-based
  date           : "YYYY-MM-DD"
  weekday        : Weekday
  startOffset    : int    // minutes from frame start to this day's local 00:00
  lengthMinutes  : int    // 1440 normally; 1380 / 1500 across a DST transition
}
```

`DayFrame` is a type alias of `Frame`, retained for call-site compatibility.
`resolveDayFrame(date, timezone)` is sugar for `resolveFrame(date, 1, timezone)`
(single-day frame — this is what most callers use today).

**Invariant: a frame always starts at local midnight.** This is what keeps
the day table trivial to build and wall-clock resolution honest across DST,
and it is never relaxed.

### 4.3 Daylight saving

- `Day.lengthMinutes` is derived from the IANA timezone database via
  `Intl.DateTimeFormat`, never assumed to be 1440.
- A wall-clock time that does not exist (spring-forward gap) resolves to the
  transition instant via binary search
  (`resolveWallClockToInstant`, `time.ts`).
- A wall-clock time that occurs twice (fall-back) resolves to its **first**
  occurrence.
- Rule windows are authored in wall-clock and resolved to frame-relative
  offsets per day using the above (`resolveWallClock`).

### 4.4 Spanning windows and midnight

Every `WindowRule` whose `endWall <= startWall` spans midnight and resolves
against the **following day's** offset in the frame's own day table
(`resolveWindows`, `resolve.ts`), producing one contiguous interval that
crosses the boundary with no special-case code. `FixedRule` spanning
midnight is resolved the same way (`resolveFixedPlacement`, `hard-set.ts`),
falling back to `lengthMinutesOfDate` when there's no `frame.days[i+1]` entry
(i.e. a spanning `FixedRule` on the frame's last day).

### 4.5 Multi-day frame boundary (`dayCount > 1`)

For a frame with more than one day, a placement is **not** clamped to
`lengthMinutes` mid-solve — window containment is what bounds a placement,
and a spanning window on the frame's last day is allowed to extend past
`lengthMinutes` (this is what makes a `strict("23:00", "07:00")` Sleep
activity "just work" across the whole frame, not only within one day).
`computeTailroom` (`constants.ts`) computes how far past `lengthMinutes` the
free-interval search would need to extend to accommodate this — see
[§13.2](#13-known-gaps-and-speccode-divergences) for its current wiring
status.

---

## 5. Domain model

### 5.1 `Activity` (template)

```
Activity {
  id               : string
  name             : string
  durationMinutes  : int, multiple of GRID, > 0
  priorityRank     : int   // 1 = most important; unique across the catalogue
  enabled          : bool  // disabled activities are excluded from solving
  rules            : Rule[]
  requiredCount    : int   // 0 = discretionary; >0 = hard-constrained (§6.2)
}
```

Built with the fluent `activity(name)` / `ActivityBuilder`
(`src/engine/activity-builder.ts`) rather than hand-assembled — this is the
supported, documented construction path. `.rank(n)` is the only required
call; `.build()` throws if it was omitted. `id`/`color`/`icon` and other
display metadata are not consumed by the solver.

**`id` may be an arbitrary caller-chosen string** — e.g. a database primary
key or an external system's identifier — not just the default
auto-slugified name. `ActivityBuilder.id(id)` overrides the
name-derived default; a hand-assembled `Activity` may set it to anything.
The id flows through unchanged into `TimelineActivity.activityId` and into
the derived occurrence/instance id
(`{activityId}@{bucketKey}#{index}`, §5.2), so it's a reasonable stable join
key back to an external store. Two things are **not** enforced by the
engine and are the caller's responsibility:

1. **Uniqueness.** `validateCatalog` checks for duplicate `priorityRank`
   only, never duplicate `id`. Two activities sharing an id silently
   collide in every internal `Map` keyed by activity id (placement lookups,
   sequence/overlap cross-references, `resolvedCache`, etc.) — there is no
   `DUPLICATE_ID`-style diagnostic.
2. **Avoid `@`, `#`, and `~` inside the id.** Those characters are the
   delimiters the engine itself uses when building occurrence/instance ids
   (`{activityId}@{bucketKey}#{index}`, chunk suffix `~{blockIndex}`) and
   when parsing an ad-hoc instance's base id back out
   (`adhocActivitiesFrom`, `solve.ts`, splits on `@`). An id containing
   one of these can produce malformed or colliding derived ids. Plain
   UUIDs, numeric database ids, and slugs are all safe.

**One activity, many possible occurrences.** Unlike v1, "one instance per
day" is no longer an engine-level ceiling — an `Activity` with a
`RepeatRule(sharedBudget: false)` expands into one `Occurrence` per bucket
per count ([§7](#7-recurrence-and-expansion)). Without that rule, an
activity still produces exactly one occurrence per eligible day, matching
the original one-instance-per-day model.

### 5.2 `TimelineActivity` (instance)

```
TimelineActivity {
  id                       : string   // = occurrenceId, or "{occurrenceId}~{blockIndex}" for a chunk
  activityId               : string | null   // null for ad-hoc
  occurrenceId             : string
  occurrenceIndex          : int      // 1-based within its bucket
  bucketKey                : string   // the recurrence period's key (a date, ISO week, "YYYY-MM", or "frame")
  date                     : string   // calendar date this placement actually falls on
  name, durationMinutes, priorityRank, requiredCount : copied at generation
  rules                    : Rule[]   // deep copy; instance-level overrides live here
  state                    : InstanceState
  completedSource          : "user" | "auto" | "backdated" | null
  plannedStart, plannedEnd : int | null   // current solver output, frame-relative
  actualStart, actualEnd   : int | null   // recorded reality
  scheduledMinutes         : int      // sum across chunks; <= durationMinutes (with EXTEND exceptions)
  blockIndex, blockCount   : int      // 1-based; blockCount = 1 when not chunked
  chunkGroupId             : string | null   // = occurrenceId for a chunked plan
  hostInstanceId           : string | null   // set when nested as a guest
  isAdhoc                  : bool
  spanningFromPreviousDay  : bool
  relaxations              : Relaxation[]
  locked                   : bool     // true for user-pinned anchors (e.g. a SKIP)
  skipReason               : SkipReason | null
}
```

Templates are never mutated by the solver — history is immutable. Once a
`TimelineActivity` is anchored (or a frame finalised), its record is frozen
even if the originating template later changes
(edge case: "catalogue differs mid-day" — `worked-examples.test.ts`,
`edge-cases.test.ts`).

**Occurrence identity** (Drop 1, still current):

```
occurrenceId = "{activityId}@{bucketKey}#{index}"
instanceId   = occurrenceId                     // single-block occurrence
             | "{occurrenceId}~{blockIndex}"     // one per block of a chunked plan
```

`bucketKey` is the frame's start date for a `period: "day"` bucket (the
common case), an ISO week key (`"2026-W31"`), a `"YYYY-MM"` key, or the
literal `"frame"` — see [§7.1](#71-buckets). Ad-hoc instances derive their
base id from a deterministic count of ad-hoc activities already present
(`adhoc-{n}`), wrapped in the same `@bucketKey#index` shape. No clock read,
no random source, anywhere in id generation.

### 5.3 `Timeline`

```
Timeline {
  dayFrame          : DayFrame
  revision          : int         // input revision + 1; a no-op TICK does not advance it
  instances         : TimelineActivity[]
  diagnostics       : Diagnostic[]
  cost              : CostBreakdown
  status            : "OK" | "DEGRADED"
  solvedAtOffset    : int         // the `now` that produced this timeline
  finalised         : bool
  carryIn           : TimelineActivity[]   // residue for the next frame; empty until finalised
}
```

`DEGRADED` means the solve succeeded and is fully returned — a day/frame is
always producible, even a bad one — but at least one hard requirement
couldn't be met (a required occurrence was skipped, or two fixed blocks
collide), accompanied by blocking diagnostics.

---

## 6. Rule reference

Six rule types (`Rule` discriminated union on `type`), each carrying
`source: "template" | "instance"` so a per-instance override
(`EDIT_INSTANCE_RULES`) is distinguishable from the template's own rule.

### 6.1 `FixedRule`

```
FixedRule { type: "fixed", startWall, endWall }
```

Immovable wall-clock span; the solver never moves, shortens, or splits it.
`endWall <= startWall` spans midnight. Placed first, unconditionally, ahead
of every other phase (§10.3). Two fixed activities whose declared times
overlap are a hard configuration error: **both** are marked infeasible with
a shared blocking diagnostic — the engine never picks an arbitrary winner. A
fixed block colliding with already-occupied anchor time (most commonly a
carry-in block, or the freeze boundary) is the same kind of hard error.

Recurring `FixedRule`s are supported ("daily standups across a month" is one
`FixedRule` + one recurrence `RepeatRule`) **as long as the activity is
ghostable** — see [§13.6](#13-known-gaps-and-speccode-divergences). A
`FixedRule` combined with an occurrence-level `count > 1` in one bucket is a
validation error (`FIXED_WITH_MULTI_COUNT`) since two occurrences at the
same declared time always collide.

### 6.2 `WindowRule`

```
WindowRule { type: "window", days: Weekday[], startWall, endWall, maxDriftMinutes }
```

The merged strict/flexible/allowed-days rule (`SPEC-v2.md` §4.1). A strict
window is a flexible window with `maxDriftMinutes: 0` — the same predicate,
not a special case. `days` is the set of weekdays the window applies on; the
union of `days` across an activity's `WindowRule`s **is** its day
eligibility (`eligibleWeekdaysOf`) — a day named by no window is a day the
activity cannot be placed on. Absence of any `WindowRule` means an implicit,
unconstrained window (every day, the full span, zero drift is not implied —
no constraint at all) unless `Frame.defaultDayWindow` supplies one
(§6.2.2).

**An activity may carry more than one `WindowRule`** — the sole exception to
"at most one rule of each type." Multiple windows union for eligibility;
drift is the **minimum** raw drift across windows, and a candidate is
feasible if at least one window's own drift clears its own allowance
(`evaluateCandidate`, `resolve.ts`):

```
drift(candidate) = min over w in windows of driftAgainst(candidate, w)
feasible = (∃ w : driftAgainst(candidate, w) <= w.maxDriftMinutes)
           AND candidate ⊆ union of windows' eligible day spans
```

**Drift may never soften day-eligibility.** A candidate must lie within the
union of every matching window's *eligible day span*
(`daySpanStart`/`daySpanEnd` — the calendar day(s) a window's `dayIndex`
covers, extended to the following day for a spanning window) regardless of
how much drift allowance it has. This is what stops a generous drift
allowance from bleeding a candidate off Tuesday's window onto Wednesday.
Enforced by `isContainedInEligibleDaySpan` and independently re-checked by
`checkInvariants` invariant 13.

Drift arithmetic (unchanged from v1's table, `SPEC.md` §5.3): minutes of the
candidate lying before the window start plus minutes lying after the window
end, each capped so a candidate lying wholly on one side isn't
double-counted past its own duration. A candidate with **no** overlap with
the window at all incurs drift equal to its own full duration.

**6.2.1 Day-only windows.** `ActivityBuilder.days(...)` restricts
eligibility even when no real time-of-day window exists, by synthesizing a
whole-day, zero-drift `WindowRule` (`00:00`–`24:00`) purely to carry the
day restriction. This synthetic window is exempt from the
`Fixed`x`Window` incompatibility check (`isDayOnlyWindow`), since it imposes
no time constraint.

**6.2.2 `Frame.defaultDayWindow`.** When an activity has no `WindowRule` at
all *and* the frame declares `defaultDayWindow` (e.g. `07:00`–`23:00`), that
frame-level window is applied per day with `maxDriftMinutes: 0`
(`resolveWindows`). Without this, an unwindowed activity in a multi-day
frame gets no time-of-day preference at all and idle-cost tie-breaking
places it at `00:00` on day 0 — harmless over one day, actively bad over a
month. Verified end-to-end in `frame-knobs.test.ts`.

### 6.3 `ElasticityRule`

```
ElasticityRule { type: "elasticity", minTotalMinutes, minBlockMinutes }
```

`minTotalMinutes`: hard floor on total scheduled time (v1's
`minDurationMinutes`). `minBlockMinutes`: hard floor on any single block
(v1's `minChunkMinutes`). Must satisfy
`minBlockMinutes <= minTotalMinutes <= durationMinutes`
(`ELASTICITY_INVALID` otherwise). Without this rule, an activity is
all-or-nothing: full duration in one block, or skipped. When a
chunking `RepeatRule` is present but no `ElasticityRule` is,
`minTotalMinutes` defaults to the full duration and `minBlockMinutes`
defaults to `GRID` — split freely, don't shorten.

### 6.4 `RepeatRule`

```
RepeatRule {
  type: "repeat"
  period: "day" | "week" | "month" | "frame"
  count: int >= 1
  sharedBudget: bool
  minSeparationMinutes: int   // default 0
}
```

**One rule, two independent operations, distinguished by `sharedBudget`:**

- `sharedBudget: true` — **chunking.** The activity's *own* duration budget
  is split across up to `count` blocks; an extra block buys nothing and
  costs `CHUNK`, so the solver minimizes block count on its own
  (`repeatRuleOf`, `greedy.ts`; `planChunks`, `shrink.ts`).
- `sharedBudget: false` — **recurrence.** `count` occurrences per bucket,
  each with its own full duration budget; a missing occurrence costs
  `W × SKIP`, so the solver maximizes count up to `count`
  (`recurrenceRuleOf`, `expand.ts`).

**An activity may legally carry one `RepeatRule` of each `sharedBudget`
value simultaneously** — "Gym three times a week, each session splittable
into two" is six blocks in three independent budget groups
(`dual-repeating-rule.test.ts`). `REPEAT_DUPLICATE` only fires for two rules
sharing the same `sharedBudget` value.

`minSeparationMinutes` (recurrence direction only) enforces
**start-to-start** spacing between sibling occurrences
(`violatesSeparation`, `placement.ts`) — a pure candidate-start filter, never
a cost term, so every candidate's cost stays local to itself. This is what
turns "three times a week, 48h apart" into Mon/Wed/Fri with no spreading
heuristic anywhere in the code.

### 6.5 `SequenceRule`

```
SequenceRule { type: "sequence", role: "pre" | "post", linkedActivityId, maxGapMinutes }
```

Attached to the **dependent**, pointing at its host. `pre`:
`dependent.end <= host.start`, gap `<= maxGapMinutes`. `post`:
`dependent.start >= host.end`, gap `<= maxGapMinutes`. Gap minutes are
costed (`GAP`), so the solver packs them tight. Placed last, in priority-
independent rounds (`placeSequenceChain`, `sequence.ts`) so a chain
(`A pre B`, `B pre C`) resolves link by link. **Dependent skip is free** —
if the host is skipped, every dependent is skipped for zero cost with
`skipReason: "HOST_SKIPPED"`, and this is explicitly excluded from ever
triggering event rejection. A host may have at most one `pre` and one `post`
(`SEQUENCE_MULTIPLE`); cycles are rejected at validation time
(`SEQUENCE_CYCLE`). A dependent that is itself `Fixed` is not treated as a
dependent at all — its declared time fully determines it.

A chunked host binds its dependents to the **outer span** of the whole chunk
plan (earliest start / latest end), not per-chunk (§13.4).

### 6.6 `OverlapRule`

```
OverlapRule { type: "overlap", budgetMinutes, allowedGuestIds: string[], exclusionWindows: ExclusionWindow[] }
ExclusionWindow { id, name, anchor: "relative" | "absolute", startOffset?, endOffset?, startWall?, endWall? }
```

Attached to the **host**. A guest is nested entirely inside its host's
placement and doesn't occupy standalone day space; its duration is satisfied
by the nesting. All guests draw from **one shared budget** per host
occurrence (does not roll over — SPEC.md §11 case 13). A guest must still
satisfy its own rules (own window, own shrink floor); guests of the same
host never overlap each other, and no guest may intersect an exclusion
window. Exclusion windows consume no duration and no budget — they're
annotations, not sub-blocks.

- `relative` anchoring moves the exclusion window with the host.
- `absolute` anchoring pins it to wall-clock time and is, upstream of
  nesting entirely, a **hard placement constraint on the host itself**: the
  host must land such that the window falls entirely inside it, in every
  phase, not just at nesting time (`resolveAbsoluteExclusions`).
- **Absolute exclusions resolve per day** (§13's Drop-2-implemented
  behavior) — an absolute exclusion constrains only the host occurrence in
  whose bucket it falls, not every occurrence of a recurring host
  (`per-day-exclusions.test.ts`).

**Nesting is evaluated in the greedy pass** against hosts already placed at
the point the guest's own turn comes (`placeGreedy`, `greedy.ts`) — this is
the entire mechanism behind `GUEST_OUTRANKS_HOST` (a guest processed before
its host has nothing to nest into yet, since ordering is ascending priority
rank). Nesting is scoped to single-block guests: a guest with its own
chunking `RepeatRule` is not split across a host's nestable regions, and a
nested guest hosting further guests (two levels deep) is not supported.

### 6.7 Compatibility matrix

|                | Fixed | Window | Repeat | Elasticity | Sequence | Overlap |
| -------------- | ----- | ------ | ------ | ---------- | -------- | ------- |
| **Fixed**      | —     | ✗      | ✗\*    | ✗          | ✓        | ✓       |
| **Window**     | ✗     | (many) | ✓      | ✓          | ✓        | ✓       |
| **Repeat**     | ✗\*   | ✓      | —      | ✓          | ✓        | ✓       |
| **Elasticity** | ✗     | ✓      | ✓      | —          | ✓        | ✓       |
| **Sequence**   | ✓     | ✓      | ✓      | ✓          | —        | ✓       |
| **Overlap**    | ✓     | ✓      | ✓      | ✓          | ✓        | —       |

\* `Fixed` × `Repeat` is forbidden **only** when the `RepeatRule` is the
chunking direction (`sharedBudget: true`) — a fixed block has nothing to
split. `Fixed` × `Repeat(sharedBudget: false)` (recurrence) is legal and is
how a recurring `FixedRule` (daily standup) is expressed
(`isFixedWithChunkingRepeat`, `validation.ts`).

Enforced by `RULE_INCOMPATIBLE`; duplicate-type checks are waived for
`window` (multiple windows are legal, §6.2) and `repeat` (two are legal iff
their `sharedBudget` differs, §6.4).

---

## 7. Recurrence and expansion

`expand()` (`src/engine/expand.ts`) is a pure pre-pass, wired into `solve()`
via `expandForSolve` (`solve.ts`), that turns `Activity[]` into
`Occurrence[]` — the solver's actual unit of work. The solver's placement
machinery (fixed / hard-set / greedy / sequence) never learns the word
"recurrence"; it only ever places occurrences.

### 7.1 Buckets

`RepeatRule.period` partitions the frame:

| `period` | Buckets | `bucketKey` |
| --- | --- | --- |
| `"day"` | one per `frame.days` entry | the day's date |
| `"week"` | ISO weeks intersecting the frame | `"2026-W31"` (`isoWeekKey`, `time.ts`) |
| `"month"` | calendar months intersecting the frame | `"2026-07"` |
| `"frame"` | one, the whole frame | `"frame"` |

An activity with no recurrence `RepeatRule` (`sharedBudget: false`) defaults
to `period: "day", count: 1` — matching both the original one-per-day model
at `dayCount = 1` and the N-chained-1-day-solves equivalence at
`dayCount > 1` (`drop2-equivalence.test.ts`).

For each bucket and each `1..count`, an occurrence is emitted whose
`windows` are the activity's resolved windows intersected with that bucket.
**A bucket with no eligible windows yields no occurrences** — day
eligibility and recurrence compose with no special case: "Gym on Mon/Wed/Fri"
with `period: "day"` produces exactly three occurrences because the other
four day-buckets contain none of Gym's windows.

An unconstrained activity (no `WindowRule`) gets a **synthetic full-bucket
window per bucket**, not one frame-wide window — otherwise nothing stops
Monday's and Tuesday's occurrence from both landing on Monday
(`syntheticBucketWindow`).

### 7.2 Determinism

`expand()` emits occurrences sorted by `(activity.priorityRank, bucketKey,
index)`. Bucket enumeration is already chronological
(`bucketKey` sorts lexicographically for `"YYYY-MM-DD"`/`"YYYY-Www"`/`"YYYY-MM"`
forms), so this only resolves cross-activity ties.

### 7.3 Group placement and separation

A required occurrence group (all occurrences of one activity sharing
`requiredCount`) is placed through `placeOccurrenceGroup` — a thin wrapper
over the same bounded-backtracking `placeHardSet` routine hard requirements
already use, not a second search. `minSeparationMinutes` is threaded through
as a candidate-start filter (`violatesSeparation`), never a cost term, so it
composes with every other feasibility check.

**Hard-set decomposition** (`placeHardSetDecomposed`, `hard-set.ts`):
required occurrences whose candidate spans don't overlap are grouped by
union-find and searched **per connected component**, each against the same
global `HARD_SET_NODE_LIMIT` backstop. Without this, a 30-day frame with
daily required activities would exhaust the node limit against hundreds of
occurrences and mass-mark the remainder infeasible.

### 7.4 `requiredCount` beyond 1

`Activity.requiredCount` is the count of the recurrence's occurrences
(by index) that carry infinite skip cost;
`isRequired = occurrenceIndex < requiredCount`. `count: 3, requiredCount: 2`
expresses "gym at least twice a week, ideally three times" with no new
machinery. `REQUIRED_COUNT_INVALID` fires for `requiredCount < 0` or
`requiredCount > count` (`required-count.test.ts`).

### 7.5 Ghosting — the current scope boundary

`isGhostable(activity, catalog)` decides whether an activity is expanded
into real, independently-placed occurrences, or kept to its original
single-instance-per-frame behavior:

- **Not ghostable:** the activity itself carries an `OverlapRule` or
  `SequenceRule`, or another activity in the catalogue names it as a guest
  (`allowedGuestIds`) or sequence partner (`linkedActivityId`).
- **Ghostable:** everything else, including a recurring `FixedRule`
  (e.g. a daily standup with no overlap/sequence involvement).

This is a deliberate, temporary scope boundary: `OverlapRule.allowedGuestIds`
and `SequenceRule.linkedActivityId` cross-reference activities by their
*catalogue* id, and rekeying those references per-occurrence
(so "Commute is a pre of every Work occurrence," for instance) is future
work, not yet implemented. Until it lands, an activity involved in an
overlap or sequence relationship keeps exactly one occurrence per frame,
regardless of any `RepeatRule` it might otherwise be eligible for.

---

## 8. Lifecycle and states

### 8.1 States

| State | Meaning | Movable by solver |
| --- | --- | --- |
| `PLANNED` | Scheduled, not started | yes |
| `ACTIVE` | Currently running | no — anchor |
| `COMPLETED` | Finished; `actualStart`/`actualEnd` recorded | no — anchor |
| `SKIPPED` | Could not be placed, or dismissed by the user | n/a |
| `CARRIED_IN` | Spans in from the previous frame's `FINALISE_FRAME` | no — anchor |

`COMPLETED` carries `completedSource ∈ {user, auto, backdated}`; the solver
treats all three identically as anchors.

### 8.2 Transitions

- **Auto-start:** at `plannedStart`, `PLANNED → ACTIVE`, no user action
  needed.
- **Auto-complete / backdating:** on any solve, every `PLANNED`/`ACTIVE`
  instance whose `plannedEnd <= now` becomes `COMPLETED`
  (`completedSource: "backdated"`, `actual = planned`) — or, if
  `Frame.backdateHorizonMinutes` is set and the block ended further than
  that many minutes before `now`, becomes `SKIPPED` with
  `skipReason: "LAPSED"` instead (`applyBackdating`, `lifecycle.ts` — see
  §8.4). A `PLANNED` instance `now` currently sits inside becomes `ACTIVE`.
  Backdating applies uniformly to every unfinalised past instance — `now`
  landing a week after the last solve is an ordinary input, not a special
  case.
- Every event implicitly performs this pass before its own effect
  (`planEvent`'s shared `TICK`/backdating setup).

### 8.3 The freeze boundary

At the start of every solve, `freezeBoundary` is (ordinarily) `now`, or
`event.at` for `FINISH_EARLY`. Everything strictly before it is immutable
and reproduced verbatim; everything at or after it is subject to re-solving
within the active scope (§10.9). Fixed activities after the boundary remain
anchors-in-spirit but are re-placed at their declared times each solve.

### 8.4 `Frame.backdateHorizonMinutes`

Caps how far back backdating can silently mark a block "perfectly
completed." Without it (the default, and v1's exact behavior), opening the
app on day 15 of a 30-day frame records fourteen days of perfect completion.
With it set, a block ending further than the horizon before `now` becomes
`SKIPPED`/`LAPSED` instead, with its planned/actual times cleared so
`scheduleCost` doesn't charge completion for something the user never did.
This is a product decision surfaced as an engine knob, not an engine
opinion (`frame-knobs.test.ts`).

### 8.5 `FINALISE_FRAME` and carry-in

`FINALISE_FRAME` requires `now >= lengthMinutes`. It backdates residue, then
walks the resulting instances: any `PLANNED`/`ACTIVE` instance whose
`plannedEnd` genuinely overflows `lengthMinutes` (a midnight-spanning
`FixedRule`, or an `EXTEND` that pushed past the boundary) is clamped in
today's own record to end exactly at `lengthMinutes`, and the overflow
becomes a new, separate, already-`locked` `CARRIED_IN` instance occupying
`[0, overflow)` — handed back as `Timeline.carryIn` for the caller to pass
into the next frame's `carryIn` input. Everything else unfinished is left
exactly as-is; nothing else is inferred. This is the **only** state that
crosses from one frame into the next by itself — the engine holds no other
cross-frame memory. Once `finalised: true`, `solve()` refuses every further
event against that timeline unconditionally, with `SPANS_FROZEN_REGION`.
See [§13.3](#13-known-gaps-and-speccode-divergences) for how this coexists
with the newer `prelude` mechanism.

---

## 9. Cost model

### 9.1 Priority weight

```
W(a) = totalRanked + 1 − priorityRank
```

`totalRanked` is fixed as the size of the *entire declared catalogue* for
the whole solve (not just today's eligible subset), so an activity's weight
is stable across days even when it's disabled or not eligible elsewhere.
`ADD_ADHOC` is the one exception: adding an activity changes the ranking
denominator for that one solve, recomputing every weight against the new,
larger total (`priorityWeight`, `cost.ts`; the `weightOverride` plumbing in
`solve.ts`).

### 9.2 Cost terms

| Term | Formula | Default | Applies when |
| --- | --- | --- | --- |
| Skip | `W(a) × SKIP` | `SKIP = 10 000` | not scheduled at all |
| Required skip | `∞` | | `requiredCount > 0` and its occurrence index is required |
| Dependent skip | `0` | | skipped because its sequence host was skipped |
| Unscheduled minute | `W(a) × SHRINK × m` | `SHRINK = 20` | `m = duration − scheduledMinutes` |
| Extra chunk | `W(a) × CHUNK × (k−1)` | `CHUNK = 200` | `k` = block count |
| Drift minute | `W(a) × DRIFT × d` | `DRIFT = 10` | minutes outside the chosen window |
| Sequence gap minute | `W(a) × GAP × g` | `GAP = 5` | gap between a dependent and its host |
| Idle minute | `IDLE × 1` | `IDLE = 1` | any minute of the frame with no top-level block |

Idle is unweighted and global — it gently favors dense schedules and breaks
ties toward earlier placement, but can never outweigh a real relaxation.

### 9.3 The dominance invariant

`SKIP` must always cost strictly more than the worst combination of legal
relaxations, or the solver "solves" a crowded schedule by discarding work:

```
SKIP > SHRINK × (duration − minTotalMinutes)
     + CHUNK  × (repeat.count − 1)          // chunking RepeatRule only
     + DRIFT  × max over windows of maxDriftMinutes
     + GAP    × sequence.maxGapMinutes
```

Terms for absent rules are zero. `validateActivity` enforces this
(`violatesDominance`, `cost.ts`) and reports `DOMINANCE_VIOLATION` naming
the offending activity. With the defaults it holds for any activity up to
roughly 8 hours with generous relaxation allowances.

### 9.4 Two levels of cost

- **Placement cost** (`placementCost`) — one candidate's cost, excludes
  idle. Used to rank candidates during single-activity search.
- **Schedule cost** (`scheduleCost`) — the whole timeline's cost, computed
  from the finished instance list by first grouping fragments sharing a
  `chunkGroupId` back into one logical occurrence (so a chunked plan's
  shrink shortfall and chunk penalty are counted once per group, not once
  per fragment), then summing skip/shrink/chunk/drift/gap plus idle.
  Returned as `CostBreakdown` and the single most useful test assertion in
  the suite.

### 9.5 Determinism and tie-breaking

Ties break, in order: cheaper cost wins outright; among equal-cost
candidates the general pattern is earlier start time, then (in the
functions that enumerate a full duration ladder) longer scheduled duration
— implemented by walking longest-to-shortest and only replacing the current
best on a *strict* improvement, which has the same effect as an explicit
sort without needing one. This pattern is not perfectly uniform across
every internal search function (`ALGORITHM.md` §5 notes this explicitly),
but the net effect at every call site is: prefer scheduling more of the
activity, then prefer the earlier start.

---

## 10. The solver pipeline

`solve()` (`src/engine/solve.ts`) is the entry point. One call does one of
two things:

- `FINALISE_FRAME` takes a short, separate path (`solveFinaliseDay`) that
  never touches the placement pipeline — pure bookkeeping (§8.5).
- Every other event does shared setup, dispatches to `planEvent` (the only
  per-event code), then runs the shared executor `runEvent` — which is the
  placement pipeline described below, plus optional rejection checking
  (§11).

### 10.1 Setup (every call)

1. **Cost constants** resolve by layering `input.constants` over
   `DEFAULT_COST_CONSTANTS` (`resolveConstants`).
2. **`totalRanked`** is fixed as `input.catalog.length` (§9.1).
3. **`input.finalised`** short-circuits every event to `SPANS_FROZEN_REGION`
   before anything else runs.
4. **`input.carryIn`** (if non-empty) is prepended to `existing` and cleared
   — this only matters on the very first solve after a `FINALISE_FRAME`;
   later solves already carry it forward inside `existing`.
5. **Today's eligible catalogue** filters `input.catalog` to `enabled`
   activities eligible on the frame's weekday (single-day frames) or all
   `enabled` activities (multi-day frames, where per-bucket window
   filtering inside `expand()` does the eligibility work instead), then
   appends one reconstructed pseudo-activity per still-relevant ad-hoc
   instance (`adhocActivitiesFrom`).
6. **Instance-level rule overrides** (`applyInstanceRuleOverrides`) are
   re-applied on top of that catalogue **unconditionally, every solve** —
   this is what makes an `EDIT_INSTANCE_RULES` override survive an
   arbitrary sequence of later `TICK`s without the caller replaying it.

### 10.2 `planEvent` → `EventPlan`

Every event reduces to a small, pure per-event function producing an
`EventPlan` (preconditions, the mutation to apply, freeze boundary, scope,
extra activities/instances, whether to check for rejection). This is the
*only* per-event code; everything downstream is one shared executor. See
[§11](#11-the-event-layer) for the plan each event produces.

### 10.3 Phase 1a — Fixed placement

Every `FixedRule` activity in the hard-scheduling pool is placed at its
declared time, unconditionally (`placeFixedSet`, `hard-set.ts`) — the only
phase with no search. Collisions (with another fixed activity, an anchor, or
the freeze boundary) mark **every** conflicted activity infeasible with one
shared blocking diagnostic (`FIXED_COLLISION`), which alone can force
`status: DEGRADED` independent of the rest of the pipeline.

### 10.4 Phase 1b — The hard set (bounded backtracking)

The remaining required activities (`requiredCount > 0`, no `FixedRule`) are
placed as a group with backtracking — the only phase allowed to reconsider
an earlier commitment.

- **Ordering:** most-constrained-first (fewest feasible candidates against
  anchors + fixed placements alone), ties by priority rank.
- **Candidates:** the activity's full elasticity ladder (full duration down
  to its floor), not just full duration — a required activity can be
  accepted shrunk rather than failing outright.
- **Search:** an explicit iterative backtracking loop (`placeHardSet`), not
  recursive — a cursor walks the ordered list, commits to the current
  candidate, and on exhaustion backtracks to the previous activity's next
  candidate. Bounded by `HARD_SET_NODE_LIMIT = 5000` total attempts; past
  the limit, everything from the current cursor onward is marked
  `INFEASIBLE_HARD_CONSTRAINT` and the search stops (a safety valve, not a
  feasibility claim).
- **Decomposition** (§7.3): routed through `placeHardSetDecomposed`, which
  partitions by candidate-span overlap first and runs one bounded search per
  component, so a multi-day frame's many required occurrences don't share
  one global node budget unnecessarily.

### 10.5 Phase 2 — Greedy placement

Everything remaining that isn't fixed, required, or a sequence dependent, in
ascending priority-rank order, **no backtracking** (`placeGreedy`,
`greedy.ts`). For each activity, two candidates are computed and the cheaper
wins:

1. The ordinary free-space result (its own elasticity/chunk search against
   whatever is currently free — §10.6).
2. A nested candidate, if the activity is an allowed guest of any host
   **already placed** at this point in the pass (§6.6). A host processed
   later in rank order, or never placed at all, simply isn't available yet
   — this single rule is the entire `GUEST_OUTRANKS_HOST` mechanism.

### 10.6 Shrink and chunk search

For an activity with an `ElasticityRule` and/or chunking `RepeatRule`
(`placeWithElasticity`, `shrink.ts`):

- **Single-block ladder:** tries full duration down to the floor in `GRID`
  steps, keeping the cheapest; ties favor the longer (earlier-tried) length.
- **Chunk search** (only if chunking is allowed): tries every chunk count
  from 2 to `count`, greedily filling the cheapest-drift regions (clipped to
  the activity's window bounds) with reservation-aware allocation so an
  early large region can't starve a later one below its minimum. A plan
  reaching less than the full duration is accepted as long as its total
  clears the elasticity floor — chunking may **partially** complete an
  activity, not just all-or-nothing on top of being split.
- The cheaper of the two wins; a tie favors the single unsplit block, so
  chunking only wins when it's strictly cheaper.

### 10.7 Phase 2.5 — Sequence dependents

Placed last, independent of priority rank, once every possible host has a
resolution (`placeSequenceChain`, §6.5). Runs in rounds so chains resolve
link by link; a dependent whose host resolved `SKIPPED` is itself skipped
for free; otherwise the cheapest adjacent gap (0, then `GRID`, up to
`maxGapMinutes`) that's legal and free wins outright, since cost rises
monotonically with gap size.

### 10.8 Phase 3 — Assembly and diagnostics

- A single placement becomes one instance; a chunk plan becomes several
  top-level instances sharing one `chunkGroupId`, with the plan's
  shrink/chunk relaxations recorded once, on the first chunk only.
- `buildDiagnostics` scans the finished list: a blocking
  `INFEASIBLE_HARD_CONSTRAINT` diagnostic per unplaced required activity
  (forces `DEGRADED`); an info `SHRUNK` diagnostic per shortened activity;
  an info `CHUNKED` diagnostic per split activity.
- `status` is `DEGRADED` if the fixed phase reported any collision, or a
  required activity ended up unplaced; otherwise `OK`. A timeline is always
  fully assembled and returned regardless of status.
- `checkInvariants` (internal-only helper, `invariants.ts`) is available to
  assert every structural invariant (§16) against any `Timeline` — used
  pervasively by the test suite, not called automatically inside `solve()`.

### 10.9 Scoped re-solve

`EventPlan.scope` bounds which occurrences are actually re-solved. Default:
`[freezeBoundary, end of the calendar day containing freezeBoundary)`
(`defaultScope`) — at `dayCount = 1` this is exactly "the rest of the day,"
v1 behavior unchanged. Occurrences whose current placement (or, if unplaced,
whose windows) fall entirely outside scope are treated as locked anchors
(`scopePartitionExisting`) — they contribute occupied time but are never
re-placed. `SolveInput.options.scope: "frame"` widens to the whole frame
(the "replan everything" button). This is what keeps a `FINISH_EARLY` on
day 2 of a 30-day frame from reshuffling day 20's already-seen plan
(`scoped-resolve.test.ts`).

### 10.10 Prelude — occupancy across a frame boundary

`SolveInput.prelude`: blocks from a *previous* frame that overlap or
precede this frame's start, expressed in **this frame's coordinates**
(negative starts allowed). The solver sets
`freezeBoundary = max(now, max(prelude[].end))`, marks
`[max(0, start), end)` occupied, and proceeds — the instance is never
duplicated; it stays owned by the previous frame's record. See
[§13.3](#13-known-gaps-and-speccode-divergences) for how the caller
currently has to assemble a prelude entry by hand.

---

## 11. The event layer

`Event` is a discriminated union; exactly one is passed per `solve()` call.
Every user-intent event's speculative result is checked for a genuine
regression (§11.9) before being committed; events that merely represent the
passage of time never reject.

| Event | Precondition | Mutation | Freeze boundary | Can reject |
| --- | --- | --- | --- | --- |
| `GENERATE_DAY` | — | none | `now` | no |
| `TICK` | — | auto-start / auto-complete / backdate; **short-circuits, revision included, if nothing changed** | `now` | no |
| `SKIP` | target `PLANNED` | mark `SKIPPED`, `locked: true`, reason `USER_SKIPPED` | `now` | no |
| `RESTORE` | target `SKIPPED` | clears `locked`, re-competes for placement | `now` | yes |
| `FINISH_EARLY` | target `ACTIVE`/`CARRIED_IN`; `actualStart <= at <= plannedEnd` | `COMPLETED`, `actualEnd = at`, `completedSource: user` | `at` | no |
| `EXTEND` | target `ACTIVE`; `minutes > 0`, grid-aligned | `plannedEnd += minutes` | `now` | yes |
| `ADD_ADHOC` | payload validates as an activity | appends instance + pseudo-activity; recomputes `totalRanked` for this solve | `now` | yes |
| `EDIT_INSTANCE_RULES` | target exists, not `COMPLETED`/`CARRIED_IN` | substitutes rules tagged `source: "instance"`; patches an anchored target in place too | `now` | yes |
| `FINALISE_FRAME` | `now >= lengthMinutes` | see §8.5 | n/a (bypasses the pipeline) | rejects only if premature |

### 11.1 `TICK` idempotence

If nothing changed state, `planEvent` short-circuits and returns the input
timeline byte-identical, **including its revision** — calling `TICK`
repeatedly with the same `now` is free of cumulative effect.

### 11.2 `SKIP` / `RESTORE`

`SKIP` sets `locked: true`, which is what makes `extractAnchors` continue
treating the skip as untouchable across any number of later `TICK`s, unlike
an ordinary automatic skip a later re-solve is free to reconsider. `RESTORE`
lifts that lock and lets the activity compete again; it can legitimately
reject as a **side effect** — restoring one activity can shift a
higher-priority neighbor enough to break a sequence dependent that was
previously comfortable.

### 11.3 `FINISH_EARLY`

Pulls the freeze boundary back to `event.at` and re-solves the remainder
from scratch — there is no separate "find something to do with the freed
time" step. An activity previously shrunk or skipped can come back at full
length purely because the ordinary search now finds more room. **There is
no "Free Time" block type** — idle time is the absence of blocks.

### 11.4 `EXTEND`

Pushes `plannedEnd` out by a grid-aligned number of minutes and re-solves
the remainder at the ordinary freeze boundary; later blocks may nudge,
shrink, or drop, each carrying its own diagnostic.

### 11.5 `ADD_ADHOC`

Builds a brand-new pseudo-`Activity` (`activityId: null` restored afterward
by `tagAdhocInstances`), validates it exactly like a catalogue entry
(`validateActivity` + `validateCatalog`), and — critically — recomputes
`totalRanked` and every weight for this one solve, since introducing a new
activity changes the priority-weighting denominator. The engine never
writes to `input.catalog`.

### 11.6 `EDIT_INSTANCE_RULES`

Replaces one or more rule types on the target's effective template for
today only (rules tagged `source: "instance"`), validates the modified
copy, and — if the target instance is currently anchored (e.g. editing an
already-`ACTIVE` host's `OverlapRule` to admit a new guest) — patches the
anchor's own rules in place too, since the anchor is what every later solve
reads back. Combined with §10.1 step 6, an override survives solve → solve →
solve indefinitely without the caller replaying the edit.

### 11.7 `SPANS_FROZEN_REGION`

Only ever produced by the top-level `input.finalised` guard — the pipeline
itself cannot alter an anchor (anchors are excluded from re-solving
entirely), so nothing inside the placement pipeline needs to check for it.

### 11.8 `UNKNOWN_INSTANCE` / `INVALID_STATE_FOR_EVENT`

Every instance-targeting event looks its target up by id in `existing`
first (`UNKNOWN_INSTANCE` if missing) and checks the target's current state
against exactly what the event requires (`INVALID_STATE_FOR_EVENT`
otherwise, naming both the state found and what's required). Never a thrown
exception, never a silent no-op.

### 11.9 Detecting a regression (`checkEventRejection`)

Compares "before" (the caller's `existing`, keyed by `occurrenceId`) against
"after" (the speculative solve), and looks specifically for an occurrence
that is `SKIPPED` after but was **not already skipped before** — an
occurrence already skipped, or skipped again for a different reason, never
triggers a rejection on its own, because the event didn't cause it. For the
first genuinely-new skip found, the rejection is classified by *why*:

| Code | Condition |
| --- | --- |
| `FIXED_COLLISION` | the newly-skipped activity has a `FixedRule` and the reason is `INFEASIBLE_HARD_CONSTRAINT` |
| `MANDATORY_UNPLACEABLE` | otherwise required and `INFEASIBLE_HARD_CONSTRAINT` |
| `STRICT_WINDOW_VIOLATED` | reason `WINDOW_UNSATISFIABLE`, was a top-level placement |
| `GUEST_WINDOW_VIOLATED` | reason `WINDOW_UNSATISFIABLE`, was previously nested (its host moved) |
| `SEQUENCE_UNSATISFIABLE` | reason `NO_FREE_SPACE`, the activity is a sequence dependent, **and its host isn't itself now skipped** |

Every other newly-observed skip (most commonly an ordinary discretionary
activity losing out on space) is accepted as an ordinary,
`DEGRADED`-flavored consequence, not a rejection.

`RejectionError` carries `code`, `message`, `conflictingInstanceIds`,
`diagnostics` (the discarded solve's blocking diagnostics), and
`bestEffortTimeline` (the discarded speculative result, free to inspect
since it was computed anyway — useful for "here's what would happen"
previews). On `REJECTED`, `SolveResult.timeline` is the **original, input**
timeline, recomputed for cost/diagnostics against the unchanged instances,
same revision — nothing was ever mutated.

---

## 12. Validation

Pure predicate functions, independent of any day/solve, returning issue
lists (never throwing). Not run automatically inside `solve()` (except for
`ADD_ADHOC` and `EDIT_INSTANCE_RULES`, which validate their own payload
inline before accepting it) — callers should validate before solving.

### 12.1 `validateActivity(activity, constants)` — per-template errors

| Code | Condition |
| --- | --- |
| `RULE_INCOMPATIBLE` | duplicate or mutually-exclusive rule pair (§6.7) |
| `DURATION_NOT_ON_GRID` | duration, window boundary, or elasticity value not a multiple of `GRID` |
| `ELASTICITY_INVALID` | `minTotalMinutes > duration`, or `minBlockMinutes > minTotalMinutes` |
| `WINDOW_INVERTED` | a non-spanning window's `endWall <= startWall` |
| `REPEAT_DUPLICATE` | two `RepeatRule`s share a `sharedBudget` value |
| `FIXED_WITH_MULTI_COUNT` | `FixedRule` + a recurrence `RepeatRule` with `count > 1` |
| `DOMINANCE_VIOLATION` | §9.3's invariant fails |
| `REQUIRED_COUNT_INVALID` | `requiredCount < 0` or `> ` the activity's recurrence `count` |

Warnings:

| Code | Condition |
| --- | --- |
| `WINDOW_TOO_SHORT` | a strict-equivalent window shorter than duration, no `ElasticityRule` |
| `DRIFT_UNAVOIDABLE` | a flexible window's unavoidable drift exceeds its own allowance |
| `NO_ELIGIBLE_DAYS` | the union of window `days` is empty |

### 12.2 `validateCatalog(activities)` — cross-activity errors

| Code | Condition |
| --- | --- |
| `PRIORITY_DUPLICATE` | two activities share a rank |
| `SEQUENCE_MULTIPLE` | a host already has a `pre` (or `post`) partner |
| `SEQUENCE_CYCLE` | the sequence graph contains a cycle |

Warning: `GUEST_OUTRANKS_HOST` — a guest's rank is numerically better than
its declared host's, so it's always processed first and nesting will never
trigger. `validateCatalog` also runs `validateActivity` internally for
every activity, so calling it alone is a full pre-flight check.

### 12.3 `validateSeparation(activity, dayFrame)` — recurrence pre-flight

`SEPARATION_UNSATISFIABLE` — pure arithmetic check that even the tightest
realistic bucket can't hold `count` sessions at `minSeparationMinutes`
apart: `count × duration + (count − 1) × minSeparation > bucketLength`.
Catches authoring mistakes ("three times a day, 6h apart" against a
60-minute duration) without running a solve. **Not called by
`validateCatalog`** — a separate opt-in check, callable directly.

### 12.4 `validateFrame(frame)` — frame pre-flight

| Code | Condition |
| --- | --- |
| `FRAME_TOO_LONG` | `dayCount > 366` |
| `FRAME_DEFAULT_WINDOW_INVALID` | `defaultDayWindow` fields aren't well-formed `"HH:MM"` |
| `FRAME_BACKDATE_HORIZON_INVALID` | `backdateHorizonMinutes` is negative or non-finite |

---

## 13. Known gaps and spec/code divergences

These are places where a prior spec document (`SPEC.md`, `SPEC-v2.md`,
`SPEC-v2.1.md`) either describes something the code doesn't yet do, or the
code has moved on from what a spec describes. Recorded explicitly so this
PRD doesn't silently repeat a stale claim.

### 13.1 `API.md` describes a pre-"Drop 1" surface

`API.md`'s type tables (`MandatoryRule`, `ShrinkRule`, `StrictWindowRule`,
`FlexibleWindowRule`, `Activity.allowedDays`, event `FINALISE_DAY`) describe
the vocabulary from *before* the Drop 1 rule-vocabulary merge. The current
barrel (`src/brain.ts`) exports the merged vocabulary
(`WindowRule`, `ElasticityRule`, `RepeatRule`, `requiredCount`,
`FINALISE_FRAME`) exclusively — `API.md` has not been updated since. Its
default-`GRID` value (`15`) is also wrong; the code default is `5`
(§4.1). This PRD supersedes `API.md` for anything the two disagree on.

### 13.2 `computeTailroom` is unused by the solve pipeline

`SPEC-v2.1` §4.1 specifies that free-interval computation should run over
`[0, lengthMinutes + tailroom)` so a spanning window on the frame's last day
isn't starved of search room. `computeTailroom` (`constants.ts`) implements
the formula and is unit-tested (`tailroom.test.ts`), but **no caller in
`solve.ts`, `hard-set.ts`, or `greedy.ts` invokes it** — free-interval
searches are bounded by `lengthMinutes` (or a `dayBoundOf` interval) with no
tailroom extension. A spanning window whose tail depends on search room past
`lengthMinutes` may therefore behave less generously than the spec
describes. This is a real, currently-open gap, not a documentation lag.

### 13.3 The cross-frame link is still `carryIn`/`CARRIED_IN`, not `prelude`/`overflow`

`SPEC-v2.1` §8 and §11 describe replacing `FINALISE_DAY`'s clamp-and-
duplicate `CARRIED_IN` mechanism with a symmetric `prelude`/`Plan.overflow`
pair, and deleting `InstanceState.CARRIED_IN`, `spanningFromPreviousDay`,
and `Timeline.carryIn` outright. **None of that deletion has happened.**
Current code:

- `FINALISE_FRAME` still performs the v1 clamp-and-duplicate: it produces
  `Timeline.carryIn` (a `CARRIED_IN`, `locked` instance) exactly as before
  (§8.5), and this remains the only *automatic* cross-frame link.
- `SolveInput.prelude` exists and is honored (marks occupied time, moves the
  freeze boundary — §10.10), but the engine **does not itself produce** the
  matching `Plan.overflow` output the spec describes. A caller wanting to
  use `prelude` today has to hand-derive the prelude entry from the
  previous frame's placed instance (exactly as `prelude-roundtrip.test.ts`
  does: subtract `lengthMinutes` from `plannedStart`/`plannedEnd` manually).

In short: **`carryIn` is the supported, automatic mechanism today.**
`prelude` is a lower-level, caller-assembled input for advanced multi-day
chaining scenarios, not (yet) a drop-in replacement.

### 13.4 Sequence + chunking binds to the outer span, not per-chunk

`SPEC.md` §5.6 specifies that a chunked host binds `pre` to its first chunk
and `post` to its last. The implementation (`solve.ts`, Phase 2.5 setup)
binds both to the chunk plan's **outer span** (earliest start, latest end)
instead — a documented, deliberate simplification, not yet exercised by any
worked scenario that combines the two features.

### 13.5 The quota ledger (`Plan.quotas` / `SolveInput.quotas`) does not exist

`SPEC-v2.1` §8.3 specifies a round-tripped ledger so a caller solving
week-by-week (while an activity recurs monthly) doesn't double-place it.
`expand()`'s `quotas` parameter exists internally
(`RepeatQuotas`, `types.ts`) but defaults to an empty map, and
**`SolveInput` has no `quotas` field at all** — there is no way for a
caller to actually populate it. Every `expand()` call inside `solve()`
treats every bucket as freshly unclaimed. `PARTIAL_BUCKET_NO_LEDGER` and
`REPEAT_PERIOD_EXCEEDS_FRAME` (the validation codes this mechanism implies)
are correspondingly not implemented anywhere in `validation.ts`. Chaining
frames at a period coarser than the frame-solving cadence is therefore not
yet safe.

### 13.6 Overlap/Sequence activities cannot yet recur (`isGhostable`)

As documented in §7.5, any activity carrying (or targeted by) an
`OverlapRule` or `SequenceRule` is excluded from real expansion and keeps
its original one-occurrence-per-frame behavior, regardless of any
`RepeatRule` it declares. `SPEC-v2.1` §7.3/§7.4 describe the target
behavior (a dependent's recurrence induced by its host; overlap budget
scoped per host occurrence) as implemented; in the actual code these remain
partially built — the per-occurrence rekeying `isGhostable`'s docstring
names as its precondition has not landed.

### 13.7 `NOT_YET_SUPPORTED` is a dead validation code

`checkNotYetSupported` (`validation.ts`) is a documented no-op — every
`RepeatRule` field it once gated (`sharedBudget: false`, non-`"day"`
periods, `minSeparationMinutes`) is now wired into placement. The function
and the `NOT_YET_SUPPORTED` code remain as a reserved choke point for a
future field, but neither is ever actually triggered today.

### 13.8 `FixedRule` merge into `WindowRule` remains deferred

`SPEC-v2.md` §4.5 explicitly scoped this out of Drop 1 to preserve v1's
"both colliding fixed activities are marked infeasible" behavior; nothing
in the current code has since attempted the merge. `FixedRule` remains a
fully separate rule type and Phase 1a remains a distinct, no-search
placement pass ahead of the hard set.

---

## 14. Public API surface

The supported import path is `@balanced/brain` (`src/brain.ts`). Everything
under `src/engine/*` is implementation detail and may change shape without
notice, even though the test suite imports directly from several of those
modules (`resolveFrame`, `isoWeekKey`, `expand`, `checkInvariants`,
`validateSeparation`, etc.) — those imports exercise internals for coverage
and are not a supported external contract.

**Exported functions:** `solve`, `activity` / `ActivityBuilder`,
`validateActivity`, `validateCatalog`, `validateFrame`, `resolveDayFrame`,
`weekdayOf`, `addDays`, `renderAscii`.

**Exported constant:** `DEFAULT_COST_CONSTANTS`.

**Exported types:** the full `Rule` union and its members (`FixedRule`,
`WindowRule`, `ElasticityRule`, `RepeatRule`, `SequenceRule`, `OverlapRule`,
`ExclusionWindow`), `Weekday`, `RuleType`, `RuleSource`, `Activity`,
`DayFrame`, `TimelineActivity`, `InstanceState`, `CompletedSource`,
`SkipReason`, `RelaxationType`, `Relaxation`, `Timeline`, `TimelineStatus`,
`Diagnostic`, `DiagnosticSeverity`, `CostBreakdown`, `CostConstants`,
`Event`, `AdhocPayload`, `SolveInput`, `SolveOptions`, `SolveResult`,
`SolveStatus`, `RejectionError`, `RejectionCode`, `ValidationIssue`,
`ValidationSeverity`.

**Notably *not* exported**, despite being live fields/types on exported
interfaces: `Frame` (only its alias `DayFrame` is exported — they're the
same shape), `Prelude`, `RepeatQuotas`, `Occurrence`, `ResolvedWindow`,
`BucketSpan`. A caller can still populate `SolveInput.prelude` structurally
(it's just `readonly TimelineActivity[]`) without importing the `Prelude`
alias.

**Internal-only, not re-exported, but load-bearing for the multi-day
features described in this document:** `resolveFrame` (`time.ts`),
`isoWeekKey` (`time.ts`), `expand` (`expand.ts`), `checkInvariants`
(`invariants.ts`), `validateSeparation` (`validation.ts`),
`computeTailroom` (`constants.ts`). Any caller needing these today must
import from `src/engine/*` directly, which is explicitly unsupported per
`API.md`'s own stated policy ("extend `src/brain.ts`'s barrel rather than
reaching into `engine/*` directly").

---

## 15. Non-functional requirements

1. **No `Date.now()` / no argument-less `new Date()` below `solve()`.**
   Time enters only as `input.now` and `input.dayFrame`/`input.frame`.
2. **No mutation of any input.** Every function returns new values.
   Verified by `immutability.test.ts` (deep-freeze + equality after solve,
   including after a rejection).
3. **No randomness, no iteration over unordered collections.** Where a map
   must be iterated, its keys are sorted first (e.g. bucket enumeration,
   §7.2).
4. **No exceptions for expected outcomes.** Infeasibility, rejection, and
   validation failure are all return values; `solve()` is total and never
   throws for well-typed input. Exceptions remain reserved for programmer
   error (a malformed type, a broken invariant in dev).
5. **No logging inside the engine.**
6. **All configuration is an argument** — `CostConstants`, `GRID`, and node
   limits arrive via `SolveInput`, with defaults supplied at the boundary.
7. **Determinism.** Two identical `solve()` calls produce deeply equal
   output (`properties.test.ts`).
8. **Performance targets** (per `SPEC-v2.1` §15.1, exercised by
   `performance.test.ts`): a 20-activity single day solves comfortably
   inside 100 ms; a 20-activity × 7-day frame under 100 ms; a 20-activity ×
   30-day frame under 500 ms.
9. **Zero non-stdlib dependencies for placement logic.** The engine's only
   dependency beyond the TypeScript/JS standard library is the runtime's
   built-in `Intl`/timezone database (`time.ts`); `fast-check` is a
   dev-only property-testing dependency, not shipped.

---

## 16. Structural invariants

Asserted by `checkInvariants` (`invariants.ts`) against any `Timeline`; a
violation is a solver bug, not a user-facing condition. Routed through every
test in the suite via a shared helper.

1. Top-level blocks never overlap each other.
2. A guest block lies entirely within its host's placement.
3. Guests of the same host never overlap each other.
4. No guest intersects any exclusion window of its host.
5. Sum of guest durations per host <= that host's overlap budget.
6. `scheduledMinutes <= durationMinutes` (with documented exceptions for
   spanning and user-`EXTEND`ed blocks), and if scheduled at all,
   `scheduledMinutes >=` the applicable floor (per-chunk floor for a
   chunked block).
7. Every placement start and end is a multiple of `GRID`.
8. No non-anchored, non-locked, non-spanning block starts before the
   effective freeze boundary.
9. Exclusion windows consume no duration and no overlap budget (a
   design-time property, not independently re-derived at runtime).
10. Every block belongs to exactly one occurrence, and every occurrence to
    exactly one bucket (blocks sharing an `occurrenceId` agree on
    `activityId`/`bucketKey`).
11. No bucket holds more occurrences of an activity than its recurrence
    `RepeatRule.count` (the quota-ledger discount described in
    `SPEC-v2.1` §14 is not applied — see §13.5).
12. Sibling occurrences respect `minSeparationMinutes`, start-to-start.
13. Every placement lies within the union of its occurrence's eligible day
    spans (independently re-resolved from the instance's own rules, not
    read back from solve-time state).
14. No two distinct occurrences share an `occurrenceId` (instances sharing
    one `occurrenceId` must also agree on `occurrenceIndex`).

---

## 17. Test coverage map

`packages/brain/tests/` (Vitest; `pnpm test` at the repo root fans this in
via `test.projects`) — organized as one file per concern, mirroring
`SPEC.md` §16's five-layer strategy (unit → scenario → snapshot → invariant
→ property). Notable files beyond the obvious per-rule-type tests
(`shrink.test.ts`, `overlap.test.ts`, `sequence.test.ts`, etc.):

- `drop1-equivalence.test.ts`, `drop2-equivalence.test.ts` — the
  regression-preservation and N-chained-frames-equal-one-frame properties
  each drop's acceptance criteria are built around.
- `expand.test.ts`, `expand-scenarios.test.ts` — the bucketing/expansion
  pre-pass in isolation and end-to-end.
- `frame-knobs.test.ts` — `defaultDayWindow` and `backdateHorizonMinutes`.
- `separation.test.ts`, `required-count.test.ts`,
  `dual-repeating-rule.test.ts` — recurrence-specific rule interactions.
- `scoped-resolve.test.ts`, `prelude-roundtrip.test.ts` — multi-day
  chaining mechanics (§10.9, §10.10).
- `per-day-exclusions.test.ts`, `day-span-containment.test.ts` — the
  per-day absolute-exclusion and eligible-day-span containment rules.
- `hard-set.test.ts`, `solver-hardset.test.ts` — bounded backtracking and
  its decomposition.
- `worked-examples.test.ts`, `worked-example-14-8.test.ts`,
  `edge-cases.test.ts` — `SPEC.md` §14's worked examples and §11's edge
  case catalogue as executable fixtures.
- `immutability.test.ts`, `properties.test.ts` — the purity/determinism
  obligations (§15) as `fast-check` property tests.
- `performance.test.ts` — the horizon-scaling budget (§15.8).
- `public-api.test.ts` — the barrel surface (§14), built exclusively from
  `@balanced/brain`'s own exports.
- `validate-frame.test.ts`, `validation.test.ts` — the full validation
  catalogue (§12).

---

## 18. Out of scope

Recorded so a reader knows these omissions are deliberate, not overlooked.
**Outside the engine by definition** (it is a library with no opinion on
any of these): storage of any kind, transport, process/scheduling
concerns, and every user interface — the caller owns the catalogue and the
timeline and hands both back on the next call; notifications are reported
as state transitions in the result, not delivered by the engine.

**Genuine feature omissions**, some deferred to future work already
scoped above (§13), others not currently planned at all: tracking ledgers,
weekly goals, rolling deficits, streaks (the solver optimises the active
scope in isolation); reality-check prompts (auto-completed activities are
assumed perfect, with no correction mechanism); travel-time estimation,
location awareness, external calendar import; shared or multi-user
schedules; learning from history to adjust durations.
