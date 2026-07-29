# Dynamic Day Scheduler — Engine Specification, v2 **Drop 2**

**Status: new behaviour. Multi-day frames, recurrence, chaining.**

This document specifies **Drop 2 of v2**. It is written against a codebase
that has already landed **Drop 1** (`SPEC-V2.md`) — the window merge, the
repeat/elasticity split, `requiredCount`, the occurrence id scheme, and the
`planEvent` / `runEvent` collapse. Drop 2 is not implementable without
those; most of its changes are the flipping of switches Drop 1 installed.

`SPEC.md` remains authoritative for everything not contradicted here: the
cost model, drift arithmetic, the tie-break chain, overlap nesting, the
freeze boundary, backdating, and the rejection catalogue. Where this
document is silent, `SPEC.md` governs.

---

## Table of contents

1. [The thesis](#1-the-thesis)
2. [The acceptance criterion](#2-the-acceptance-criterion)
3. [Frame](#3-frame)
4. [Windows across a frame](#4-windows-across-a-frame)
5. [Expansion: the solver's new unit of work](#5-expansion-the-solvers-new-unit-of-work)
6. [Separation and group placement](#6-separation-and-group-placement)
7. [Rule interactions](#7-rule-interactions)
8. [Chaining: prelude, overflow, quotas](#8-chaining-prelude-overflow-quotas)
9. [Scoped re-solve](#9-scoped-re-solve)
10. [Performance](#10-performance)
11. [Deletions](#11-deletions)
12. [Cost model at long horizons](#12-cost-model-at-long-horizons)
13. [Validation](#13-validation)
14. [Structural invariants](#14-structural-invariants)
15. [Build order and acceptance](#15-build-order-and-acceptance)

---

## 1. The thesis

**The solver stops solving `Activity` and starts solving `Occurrence`.**

Every requirement in this drop is the same generalisation applied to a
different axis, and in every case the v1 behaviour is the degenerate case:

| Axis | Before | After | Degenerate case |
| --- | --- | --- | --- |
| Frame | 1 day, `[0, 1440)` | N days, `[0, Σ dayLen)` | `dayCount = 1` |
| Windows | one per rule | one **per eligible day** | 1 day → 1 window |
| Instances | 1 per activity | N per activity per **bucket** | `{period: day, count: 1}` |
| Re-solve scope | "rest of the day" | "rest of the current **bucket**" | bucket = day |

That symmetry is the design. It is also the test strategy: the Drop 1
corpus remains a valid regression suite at `dayCount = 1, count = 1`, and
must stay green throughout.

Two things follow that are worth stating up front, because they are the
whole payoff:

- **The carry-over problem does not get solved. It ceases to exist.**
  `days[i].startOffset` is an ordinary integer. A block at 23:30 running 60
  minutes crosses it and nothing in the engine notices.
- **Recurrence needs no new search.** Expansion is a pre-pass; the
  pipeline below it receives more units and is otherwise unchanged.

---

## 2. The acceptance criterion

> **Solving N consecutive 1-day frames must produce placements identical to
> solving one N-day frame, for any catalogue containing no cross-day
> rules.**

"No cross-day rules" means: every `RepeatRule` has `period: "day"`, no
window spans midnight, and no activity's duration exceeds a day.

This one property test is worth more than the rest of the Drop 2 suite
combined. It proves the day table, window expansion, bucketing, and cost
aggregation simultaneously, and it fails loudly on exactly the class of bug
that scenario tests cannot see — a schedule that is quietly, subtly worse
over a horizon nobody eyeballed.

Build it before step 2 of Section 15, not after step 7.

Secondary criteria:

- The Drop 1 suite passes unchanged at `dayCount = 1`.
- A 20-activity, 7-day frame solves in under 100 ms; a 30-day frame in
  under 500 ms.

---

## 3. Frame

`Frame.dayCount` is unpinned. Everything else about the type is as Drop 1
specified it.

```
Frame {
  startDate               : "YYYY-MM-DD"
  timezone                : IANA zone
  startInstant            : UTC ms of local 00:00 on startDate
  dayCount                : int ≥ 1
  lengthMinutes           : int          // Σ days[].lengthMinutes
  days                    : Day[]        // dayCount entries
  defaultDayWindow?       : { startWall, endWall }   // Section 3.2
  backdateHorizonMinutes? : int                      // Section 3.3
}
```

`resolveFrame(startDate, dayCount, timezone)` builds `days[]` by walking
local midnight to local midnight, `dayCount` times, using `time.ts`'s
existing DST resolution unchanged. A frame containing a transition simply
has one day of 1380 or 1500 minutes, and `lengthMinutes` is the sum. No
arithmetic anywhere else in the engine needs to know.

**The invariant holds: a frame always starts at local midnight.** Do not
relax it. It is what makes the day table trivial and wall-clock resolution
honest.

`dayCount` is capped at 366 (`FRAME_TOO_LONG`).

### 3.1 Day boundaries are not special

Delete every remaining behaviour that treats `lengthMinutes` — or a day
boundary within the frame — as a wall:

- No clamping of a placement at a day boundary.
- No splitting of an instance into a "today" part and a "tomorrow" part.
- The `s + d ≤ lengthMinutes` feasibility check is **removed**. Window
  containment (Section 4) bounds placements instead, which is stricter and
  correct at both ends.

### 3.2 `defaultDayWindow`

An activity with no `WindowRule` has an implicit window covering every day
in full. Over one day that is harmless. Over a month it is actively bad:
idle-cost tie-breaking will place an unwindowed 60-minute activity at
00:00 on day 0, because that is the earliest free minute in the frame.

`Frame.defaultDayWindow` (e.g. `07:00`–`23:00`) supplies the implicit
window instead, per day, with `maxDriftMinutes: 0`. When unset, the
implicit window remains the full day and behaviour is exactly as before.

This is a small field with a large quality effect, and it is also half the
answer to Section 10's performance problem — an unwindowed `period: frame`
occurrence is the one case whose candidate set is not naturally bounded.

### 3.3 Backdating horizon

`SPEC.md` §6.2 backdates every `PLANNED` block entirely before `now` to
`COMPLETED`, and explicitly declares this needs no special case. That is
true at one day and alarming at thirty: opening the app on day 15 silently
records fourteen days of perfect completion.

`Frame.backdateHorizonMinutes` caps it. Blocks ending more than that far
before `now` are marked `SKIPPED` with reason `LAPSED` instead of
`COMPLETED`. When unset, behaviour is exactly as today.

This is a product decision surfaced as an engine knob, not an engine
opinion. The engine's obligation is to make both behaviours expressible and
neither implicit.

---

## 4. Windows across a frame

A `WindowRule` resolves to **one interval per matching day in the frame**,
not one interval per rule.

```
resolveWindows(activity, frame) → ResolvedWindow[]

ResolvedWindow { start, end, maxDriftMinutes, dayIndex }
```

For each `WindowRule` on the activity and each day `d` in `frame.days`
whose weekday is in `rule.days`:

```
start = d.startOffset + withinDay(rule.startWall, d)
end   = rule.endWall > rule.startWall
        ? d.startOffset + withinDay(rule.endWall, d)
        : frame.days[d.index + 1].startOffset + withinDay(rule.endWall, days[d.index + 1])
```

**Spanning windows now just work.** `strict("23:00", "07:00")` for Sleep is
a contiguous interval across the day boundary — no hack, no special case,
no carry-in. This is the same deletion as Section 3.1 seen from the rule
side.

Feasibility and drift are as Drop 1 defined them, over the expanded list:

```
drift(candidate)  = min over w in windows of driftAgainst(candidate, w)
feasible          = ∃ w : driftAgainst(candidate, w) ≤ w.maxDriftMinutes
                     AND candidate ⊆ union of eligible day spans
```

The second conjunct is the containment check Drop 1 specified but could not
reach. **It is reachable now.** With a large drift allowance, a candidate
could otherwise bleed out of Tuesday's window far enough to land on
Wednesday — a day the activity may not be eligible for. Drift softens the
*window*; it must never soften *day eligibility*.

### 4.1 The frame's trailing edge

A spanning window on the last day extends past `lengthMinutes`. Do not clip
it — clipping truncates someone's sleep at an arbitrary boundary and
reintroduces the problem this drop exists to delete.

Instead:

- Free-interval computation runs over `[0, lengthMinutes + tailroom)`,
  where `tailroom = max(0, max over windows of (w.end − lengthMinutes))`.
  Derived, not configured.
- A placed block ending past `lengthMinutes` is emitted in `Plan.overflow`
  and becomes the next frame's `prelude` (Section 8).
- Idle cost is computed over `[0, lengthMinutes)` only.

---

## 5. Expansion: the solver's new unit of work

Expansion is a pure function that sits **above** the solver and **inside**
the engine package. The solver never learns the word "recurrence."

```
expand(catalog, frame, quotas) → Occurrence[]

Occurrence {
  id            : "{activityId}@{bucketKey}#{index}"
  activity      : Activity
  bucketKey     : string
  index         : int              // 1-based within the bucket
  windows       : ResolvedWindow[] // eligible windows ∩ bucket
  required      : bool             // index ≤ activity.requiredCount
  siblingIds    : string[]         // other occurrences in the same bucket
}
```

### 5.1 Buckets

`RepeatRule.period` partitions the frame:

| `period` | Buckets | `bucketKey` |
| --- | --- | --- |
| `"day"` | one per `frame.days` entry | the day's `date` |
| `"week"` | ISO weeks intersecting the frame | `"2026-W31"` |
| `"month"` | calendar months intersecting the frame | `"2026-07"` |
| `"frame"` | one, `[0, lengthMinutes)` | `"frame"` |

Bucket spans are clipped to the frame. Buckets are enumerated in
chronological order; `bucketKey` sorts lexicographically in that same
order, which is what keeps expansion deterministic without a sort
comparator.

### 5.2 The rule

For each bucket `B` and each `k` in `1 .. (count − quotaPlaced(activityId, B.key))`:

> Emit an occurrence whose `windows` are the activity's resolved windows
> intersected with `B`.

**A bucket with no eligible windows yields no occurrences.** This is how
day-eligibility and recurrence compose with no special case at all: Gym on
Mon/Wed/Fri with `period: "day"` produces occurrences on exactly three days
because the other four buckets contain none of its windows. Nothing filters
anything; the intersection is empty and the loop produces nothing.

### 5.3 Determinism

Expansion emits occurrences sorted by `(activity.priorityRank, bucketKey,
index)`. Every map iterated during expansion has its keys sorted first.
`SPEC.md` §12.2 rule 3 is unchanged and unforgiving here: bucket maps are
the most likely place in v2 for a determinism leak to enter.

### 5.4 Two levels of repeat

`RepeatRule` is one operation applied at two levels, as Drop 1 §4.4
specified:

```
Activity   ──Repeat(sharedBudget: false)──▶  Occurrences   ← this drop
Occurrence ──Repeat(sharedBudget: true) ──▶  Blocks        ← Drop 1
```

The levels compose: Gym three times a week, each session splittable into
two, is six blocks in three budget groups. `chunkGroupId` is the
`occurrenceId`, so the grouping survives into `scheduleCost` and each
session's shrink shortfall is priced once. Do not allow a third level.

### 5.5 Downstream contract

`runPipeline` takes `Occurrence[]` where it took `Activity[]`. The phases
are otherwise unchanged: fixed → hard set → greedy → sequence. Occurrences
share their activity's `priorityRank`, so the greedy pass processes all
occurrences of rank 1 before any of rank 2, chronologically within an
activity. This mirrors v1 semantics exactly: importance dominates, and a
month behaves like a day.

---

## 6. Separation and group placement

### 6.1 `minSeparationMinutes`

Without it, "gym three times a week" is legally satisfied by three
back-to-back sessions on Monday — they do not overlap, so no invariant
objects.

```
RepeatRule.minSeparationMinutes : int   // default 0
```

**Semantics: start-to-start.** Two sibling occurrences must satisfy
`|a.start − b.start| ≥ minSeparationMinutes`. Start-to-start is the
unambiguous reading of "three times a day, six hours apart" and of "48
hours between gym sessions"; end-to-start would make the constraint depend
on how much each session was shrunk.

**Implementation: a candidate-start filter**, not an occupancy inflation.
When placing occurrence `k`, discard any candidate start within
`minSeparationMinutes` of an already-placed sibling's start. Five lines,
reusing the existing enumeration.

**Separation is feasibility, never cost.** A "spread" cost term
(penalising clustering, minimising variance) is more expressive and must be
rejected: it makes one candidate's cost depend on where its siblings
landed, which breaks the per-candidate locality the entire greedy search
rests on. Every cost term stays local.

Pleasant consequence: greedy-earliest plus separation produces Mon/Wed/Fri
for three-times-weekly at 48-hour separation, with no spreading heuristic
anywhere in the code.

### 6.2 Group placement

Pure greedy can paint itself into a corner: occurrence 1 takes the cheapest
slot, and occurrences 2 and 3 can no longer satisfy separation.

**An occurrence group is placed through the existing bounded-backtracking
routine in `hard-set.ts`.** Groups are small (N ≤ 31), the search is
already written and tested, and the node limit already bounds it. Order
within the group is most-constrained-first, ties by bucket order — the
heuristic the routine already implements.

Do not write a second search. If `placeOccurrenceGroup` is not a thin
wrapper over `placeHardSet`, something has gone wrong.

### 6.3 `requiredCount`

Occurrences with `index ≤ activity.requiredCount` carry infinite skip cost
and join the hard set; the rest are discretionary.

`count: 3, requiredCount: 2` is "gym at least twice a week, ideally three
times" — expressed entirely in the existing cost model, with no new
machinery. This is why Drop 1 introduced the field as a count rather than a
boolean.

Without it, `requiredCount: 1` over a 30-day frame means thirty mandatory
occurrences that cannot all fit, and every solve returns `DEGRADED`. That
is the footgun the field exists to defuse.

---

## 7. Rule interactions

Each of these is a place where multi-occurrence semantics are genuinely
ambiguous and must be decided rather than discovered.

### 7.1 Fixed

`FixedRule` resolves per bucket: `period: "day", count: 1` gives one
occurrence per day, each resolving `09:00` against its own day. Daily
standups across a month now need one solve instead of thirty. Collision
detection is unchanged logic, now operating across days.

`FixedRule` with `count > 1` in one bucket is a validation error
(`FIXED_WITH_MULTI_COUNT`) — two occurrences at the same declared time
always collide.

Drop 1 deliberately kept `FixedRule` separate from `WindowRule`; that
decision is unchanged here. The merge remains a post-Drop-2 candidate.

### 7.2 Elasticity

Applies **per occurrence**. Each occurrence carries its own full duration
and its own `minTotalMinutes` floor. Three gym sessions of 60 minutes with
a 45-minute floor is three independent budgets, not one 180-minute budget.

### 7.3 Sequence

**A dependent's recurrence is induced by its host.** The dependent gets one
occurrence per *placed* host occurrence, paired by index. Commute is a
`pre` of Work; Work recurs daily; Commute therefore recurs daily, bound to
each Work occurrence.

- `hostResolutions` is keyed by **occurrence id**, not activity id.
- A dependent declaring its own `RepeatRule` that differs from its host's
  is a validation error (`SEQUENCE_REPEAT_CONFLICT`). Induction is the only
  legal source of a dependent's recurrence.
- Dependent skip remains free (`HOST_SKIPPED`, zero cost) and remains
  excluded from triggering rejection.
- A chunked host still binds `pre` to its earliest block and `post` to its
  latest (`SPEC.md` §5.6's per-chunk binding remains deferred).

### 7.4 Overlap

- **Budget is per host occurrence.** It does not roll over between
  occurrences, exactly as `SPEC.md` §11 case 13 says it does not roll over
  between days.
- **Guests are matched to host occurrences by span, not by pairing.** The
  nested search scans already-placed host occurrences; a guest occurrence
  nests wherever it fits. No index pairing is needed or wanted.
- **Relative exclusion windows** move with their host occurrence,
  unchanged.
- **Absolute exclusion windows resolve per day**, and — this is the
  behaviour change — **an absolute exclusion constrains only the host
  occurrence in whose bucket it falls.** v1's rule ("the host must contain
  every absolute exclusion") is unsatisfiable the moment there are thirty
  of them. Without this scoping, every recurring host with an absolute
  exclusion is skipped.

### 7.5 Mandatory hosts and nesting order

`GUEST_OUTRANKS_HOST` remains a warning with the same cause: the greedy
pass places in ascending rank, so a guest processed before its host has no
host to nest into. Unchanged by recurrence — occurrences of one activity
share a rank.

---

## 8. Chaining: prelude, overflow, quotas

Three v1 mechanisms — `freezeBoundary`, `carryIn`, `finalised` — collapse
into one channel.

### 8.1 Prelude

```
SolveInput.prelude : TimelineActivity[]
```

Blocks from the previous frame that overlap or precede this frame's start,
**expressed in this frame's coordinates**. Starts may be negative.

A block that ran 22:00–01:00 across the boundary arrives as
`{ start: −120, end: 60 }`. The solver:

1. sets `freezeBoundary = max(now, max(prelude[].end))`
2. marks `[max(0, start), end)` occupied
3. proceeds

**The instance is not duplicated.** It stays owned by the previous frame.
There is no `CARRIED_IN` record, no reconciliation, no split, no clamp.
This is the entire carry-over mechanism.

Two obligations:

- **`FINISH_EARLY` may target a prelude block.** It lowers the freeze
  boundary and frees time. The modified prelude entry is echoed in
  `Plan.prelude` so the caller can write it back to the previous frame's
  record.
- **Prelude entries participate in `hostResolutions`.** Without this, a
  `post` dependent whose host lives in the previous frame is silently
  skipped. Three lines; do not omit them.

### 8.2 Overflow

```
Plan.overflow : TimelineActivity[]
```

Blocks placed in this frame that end past `lengthMinutes` (Section 4.1).
The caller passes them as the next frame's `prelude`, translated by
`−lengthMinutes`. Symmetric with §8.1 and derived, not configured.

### 8.3 The quota ledger

If the caller solves week by week but an activity recurs three times per
*month*, neither week alone knows how many sessions the month already has.

```
Plan.quotas       : { activityId, periodKey, placed }[]
SolveInput.quotas : the same, from the previous frame
```

Expansion generates `count − placed` occurrences for a partially consumed
bucket (Section 5.2). The engine emits the ledger; the caller round-trips
it. **No cross-frame state lives inside the engine** — the ledger is an
ordinary input and an ordinary output, exactly as `carryIn` was.

The ledger is *mandatory for correctness* whenever a frame edge cuts a
bucket. A frame whose edges cut a bucket and which receives no ledger gets
warning `PARTIAL_BUCKET_NO_LEDGER`.

### 8.4 `FINALISE_FRAME`

`FINALISE_DAY` becomes `FINALISE_FRAME` and loses its only substantial
logic — the overflow clamp-and-duplicate branch, which Section 3.1 deleted.
What remains:

1. require `now ≥ lengthMinutes`
2. apply backdating
3. emit `Plan.overflow` and `Plan.quotas`
4. set `finalised = true`

It still bypasses the placement pipeline entirely, and a finalised frame
still refuses every subsequent event with `SPANS_FROZEN_REGION`.

---

## 9. Scoped re-solve

This is the change nobody predicts and everybody needs.

"Every change is a full re-solve of the remainder" is an excellent rule at
1440 minutes and a serious UX regression at 44,640. A `FINISH_EARLY` on day
2 of a month re-solves 29 remaining days, and day 20's plan — which the
user has already looked at and committed to mentally — reshuffles for
reasons invisible to them.

### 9.1 Scope

```
EventPlan.scope : Interval    // added to the Drop 1 EventPlan
```

Default: `[freezeBoundary, end of the day containing freezeBoundary)`.

**At `dayCount = 1` this is exactly "the rest of the day" — v1 behaviour,
unchanged.** Same generalisation, fourth application.

An occurrence is **in scope** if its current placement intersects `scope`,
or it is unplaced and has windows intersecting `scope`. In-scope
occurrences are re-solved; every out-of-scope occurrence is an anchor and
contributes occupied time. Placements are therefore confined to the scope
automatically, by free-space arithmetic — no separate bound is needed.

### 9.2 Widening

Scope widens, in this order, only when:

1. **A required occurrence in scope cannot be placed.** Widen to that
   occurrence's full period bucket and retry once.
2. **The event changes a bucket's occurrence count** (`ADD_ADHOC` with a
   repeat, or an `EDIT_INSTANCE_RULES` touching `RepeatRule`). Widen to the
   affected buckets.
3. **The caller asks.** `SolveInput.options.scope: "frame"` forces a full
   re-solve — the "replan everything" button.

`GENERATE_DAY` always uses `[freezeBoundary, lengthMinutes)`.

Widening is bounded: at most one retry per event, then accept the scoped
result and report.

### 9.3 Scoped rejection

`checkEventRejection` compares only in-scope occurrences.

This falls out for free — out-of-scope occurrences are anchors and cannot
have changed — and it fixes a real brittleness: an `EXTEND` on day 1 must
not be rejected because occurrence #30 was displaced.

---

## 10. Performance

The naive numbers do not work. At `GRID = 15`, a 30-day frame has 2,976
grid starts; times an elasticity ladder times ~600 occurrences is roughly
14M candidate evaluations. The 100 ms budget is missed by more than an
order of magnitude.

**The fix is structural, not an optimisation:** candidate starts are
enumerated within `occurrence.windows ∩ bucket ∩ freeIntervals`, never over
the frame. A daily-bucketed occurrence therefore searches exactly as much
space as it does today, and total work becomes **linear in horizon length**:
about 460k evaluations for the same month.

The recurrence bucket is simultaneously the semantic unit and the
performance unit. The one unbounded case — `period: "frame"` with no window
rule — is precisely the case `defaultDayWindow` (§3.2) also fixes. Both
problems have one solution.

### 10.1 Hard-set decomposition

`HARD_SET_NODE_LIMIT = 5000` against 600 required occurrences exhausts
immediately, and the safety valve then mass-marks the remainder infeasible
— a catastrophic, silent quality failure.

**Required occurrences whose candidate spans are disjoint cannot conflict.**
Group them by window-span overlap (union-find), and run the existing
bounded search **per component**. Daily-bucketed activities yield roughly
one component per day: thirty searches of five to ten items, each far
inside the node limit.

About twenty lines. Keep the global node limit as a backstop across all
components.

---

## 11. Deletions

Drop 2 is net-negative in code. Remove:

| Removed | Replaced by |
| --- | --- |
| `InstanceState.CARRIED_IN` | prelude occupancy (§8.1) |
| `TimelineActivity.spanningFromPreviousDay` | nothing — a block simply spans |
| `Timeline.carryIn` | `Plan.overflow` (§8.2) |
| `FINALISE_DAY`'s clamp-and-duplicate branch | nothing (§8.4) |
| `placeFixedSet`'s "resolve end against tomorrow's frame" hack | day-table arithmetic (§4) |
| The `s + d ≤ lengthMinutes` feasibility check | window containment (§4) |
| The "may this activity span midnight?" predicate | nothing — all activities may |

Anything that still asks "does this cross midnight?" after Drop 2 lands is
a bug. Grep for it before declaring the drop done.

---

## 12. Cost model at long horizons

The formula and every constant are unchanged. Two consequences of a longer
frame are worth stating so they are not mistaken for regressions.

**Idle.** Computed over `[0, lengthMinutes)`, so a month's idle is roughly
40,000 rather than 1,000. It remains unweighted, remains 1 per minute, and
remains incapable of outweighing any real relaxation (`SKIP` is 10,000 ×
weight). It still gently favours dense schedules and still breaks ties
toward earlier placement. Report it per day as well as per frame; a
five-figure idle number in a UI is noise.

**Weight.** `totalRanked` is the size of the full declared catalogue, not
the occurrence count. Occurrences of one activity share its weight. Do not
let expansion inflate the denominator, or every activity's weight shifts
when an unrelated one changes its `count`.

**The dominance invariant** (`SPEC.md` §7.4) is per occurrence and its
arithmetic is unchanged. `CHUNK × (count − 1)` uses the shared-budget
repeat's count, not the occurrence-level one.

---

## 13. Validation

### 13.1 Removed

`NOT_YET_SUPPORTED` — Drop 1's gate on `sharedBudget: false`, `period ≠
"day"`, and `minSeparationMinutes ≠ 0` is lifted. `REQUIRED_COUNT_INVALID`
now only fires on `requiredCount < 0` or `requiredCount > count`.

### 13.2 New

| Code | Severity | Condition |
| --- | --- | --- |
| `SEPARATION_UNSATISFIABLE` | error | `count × duration + (count − 1) × minSeparation > bucket length` |
| `FIXED_WITH_MULTI_COUNT` | error | `FixedRule` with an occurrence-level `count > 1` |
| `SEQUENCE_REPEAT_CONFLICT` | error | A dependent declares a `RepeatRule` differing from its host's |
| `FRAME_TOO_LONG` | error | `dayCount > 366` |
| `REPEAT_PERIOD_EXCEEDS_FRAME` | warning | `period` is coarser than the frame; the ledger is required |
| `PARTIAL_BUCKET_NO_LEDGER` | warning | A frame edge cuts a bucket and no `quotas` were supplied |

`SEPARATION_UNSATISFIABLE` is the recurrence analogue of `WINDOW_TOO_SHORT`
and catches the most common authoring mistake by pure arithmetic, before
any solve. It is cheap and high-value; do not skip it.

---

## 14. Structural invariants

`SPEC.md` §4.5's nine invariants hold unchanged. Add five, and assert them
on every result:

10. Every block belongs to exactly one occurrence, and every occurrence to
    exactly one bucket.
11. No bucket holds more occurrences of an activity than
    `count − quotaPlaced`.
12. Sibling occurrences respect `minSeparationMinutes`, start to start.
13. Every placement lies within the union of its occurrence's eligible day
    spans.
14. No two occurrences share an `occurrenceId`.

Route every test through the `checkInvariants` helper, as `SPEC.md` §16.1
layer 4 requires. This is still the single highest-leverage thing in the
test strategy, and it matters more here than it did in v1 — combinatorial
bugs across a month are invisible to inspection.

---

## 15. Build order and acceptance

Each step ends with the Drop 1 suite green at `dayCount = 1`.

| # | Step | Done when |
| --- | --- | --- |
| 1 | `resolveFrame(date, N, tz)`; day table; window expansion per day; spanning windows | Drop 1 suite green. A spanning strict window resolves to one contiguous interval. |
| 2 | `dayCount > 1`, repeat still pinned to `{day, 1, shared}` | **The §2 equivalence test passes.** Carry-over deletions (§11) land here. |
| 3 | `expand()`, buckets, `sharedBudget: false`, `count > 1` | Three-times-weekly produces three occurrences in the right buckets. |
| 4 | `minSeparationMinutes`; group placement via `placeHardSet` | Mon/Wed/Fri falls out of 3×/week at 48h separation, with no spreading code. |
| 5 | `requiredCount > 1`; hard-set decomposition | A 30-day frame with daily required activities solves inside the node limit. |
| 6 | Prelude, overflow, quotas, `FINALISE_FRAME` | A block spanning a frame boundary survives as one instance across two solves. |
| 7 | Scoped re-solve and scoped rejection | `FINISH_EARLY` on day 2 of a 30-day frame leaves day 20 byte-identical. |
| 8 | `defaultDayWindow`, `backdateHorizonMinutes`, per-day absolute exclusions | Each has a named test. |

Step 2 is the hinge. If the equivalence test does not pass there, do not
proceed to step 3 — every later step compounds whatever it would have
caught.

### 15.1 Acceptance criteria for Drop 2

1. The §2 equivalence property holds over ≥ 1,000 generated catalogues.
2. The Drop 1 suite passes unchanged at `dayCount = 1, count = 1`.
3. Every property in `SPEC.md` §16.1 layer 5 still holds — determinism,
   input immutability, no overlap, shrink floor, mandatory, cost
   monotonicity, tick idempotence, rejection purity — over N-day frames.
4. All fourteen structural invariants (§14) run on every result produced
   anywhere in the suite and never fire.
5. Every code in §13.2 is reached by at least one test.
6. Performance: 20 activities × 7 days under 100 ms; × 30 days under
   500 ms.
7. A scoped re-solve on a 30-day frame leaves every out-of-scope instance
   byte-identical, including ids and relaxations.
8. Round-trip: solving a month as one frame and as four chained weekly
   frames with the ledger produces the same occurrence *counts* per period
   (placements may legitimately differ; counts may not).
9. `grep` finds no remaining midnight, carry-in, or day-boundary special
   case (§11).

Criteria 1 and 7 are the two that will actually find bugs. The rest confirm
that nothing regressed.