# How the Dynamic Day Scheduler actually works

This document describes the algorithm as it is implemented today — what the
solver actually computes, in what order, and why the code takes the shape it
does. It complements two other documents rather than repeating them:
`SPEC.md` is the behavioral contract (what the engine must guarantee);
`API.md` is the calling convention (what a caller passes in and gets back).
This document is the middle layer: given one call to `solve()`, what
actually happens inside it, step by step, including the specific search and
tie-breaking strategies, the exact order operations run in, and the
shortcuts and simplifications the implementation takes versus the more
general spec. Where the implementation deliberately diverges from or
narrows the spec, that is called out explicitly rather than glossed over.

Everything below lives under `app/brain/engine/`, split across one file per
concern; a file name is mentioned only where it helps you find the code
behind a step.

---

## 1. The shape of one `solve()` call

`solve()` is a single pure function. Nothing survives between calls except
what the caller explicitly passes back in (`existing`, `carryIn`,
`revision`). Every call re-derives everything from scratch: which
activities are eligible today, how wall-clock rules map to minute offsets,
what's already committed, and what still needs deciding.

At the top level, a call does one of two things:

- If the event is ending the day (`FINALISE_DAY`), it takes a short,
  separate path that never touches the placement engine at all — it just
  reconciles bookkeeping and hands off to tomorrow (Section 16).
- For every other event, it does a shared setup pass (Section 3), then
  dispatches to one event-specific handler. Every one of those handlers —
  whether it's the initial `GENERATE_DAY`, the idle `TICK`, or a targeted
  edit like `SKIP` — funnels through the same placement pipeline (Sections
  4–13) with different inputs: which activities are still "up for grabs,"
  what's already occupying the day, and where the freeze boundary sits.
  Handlers that represent a specific user action then run one extra check
  (Section 15) before committing to the result.

## 2. Time: turning wall-clock rules into plain numbers

Everything a rule says in wall-clock terms ("09:00", "17:30") is converted,
once per activity per solve call, into a plain integer count of minutes
since the day frame's own start. From that point on the entire engine only
ever adds, subtracts, and compares integers — there is no timezone-aware
arithmetic anywhere in the placement logic itself.

The conversion has to be careful because a timezone's offset from UTC is
not constant: it changes across a daylight-saving transition. Given a
calendar date, a wall-clock time, and an IANA zone, the resolver first
makes a naive guess (treat the wall-clock numbers as if they were already
UTC), then samples the zone's real offset twice — once comfortably before
that guess and once comfortably after, far enough apart that any DST
transition affecting this particular moment is guaranteed to fall somewhere
inside that window, while an ordinary non-transition day still has both
samples agree. If the two samples agree, there's no ambiguity: the guess
minus that one offset is the answer. If they disagree, the resolver builds
the two candidate instants implied by each offset and checks which one (or
ones) actually round-trip back to the requested wall-clock time:

- Both round-trip: the requested time occurred twice (a fall-back repeated
  hour). The engine always resolves to the earlier of the two occurrences.
- Only one round-trips: that's the unambiguous answer.
- Neither round-trips: the requested wall-clock time never existed (it fell
  inside a spring-forward gap). The resolver binary-searches between the two
  candidates for the exact transition boundary and resolves to that instant
  instead, snapped to the nearest whole minute.

A day frame's own length in minutes (normally 1440) is derived the same
way, as the whole-minute distance between local midnight on the target date
and local midnight on the following date — which is what makes a
1380-minute or 1500-minute day around a DST transition fall out of the
existing arithmetic automatically rather than needing special-cased
handling anywhere else in the engine.

Every activity's `FixedRule`, `StrictWindowRule`, and `FlexibleWindowRule`
boundaries are resolved this way exactly once per `solve()` call and cached
for the duration of that call (keyed by activity id), since the resolution
itself is comparatively expensive (it does the timezone sampling above) and
several phases below re-resolve the same activities repeatedly.

## 3. Setting up a solve call

Before any event-specific logic runs, every call does the same preparatory
work:

- **Cost constants** are resolved by layering any caller-supplied overrides
  on top of the built-in defaults (grid size, and the per-unit costs of
  skipping, shrinking, chunking, drifting, and leaving a gap).
- **`totalRanked`** — the denominator used for priority weighting — is
  fixed as the size of the *entire* declared catalog, not just the
  activities eligible today. An activity's weight is therefore stable
  across days even if it happens to be disabled or not allowed on a
  particular weekday elsewhere in the catalog.
- If the caller passed a non-empty `carryIn` (residue from yesterday's
  `FINALISE_DAY`), it is prepended to `existing` and cleared from the input
  before anything else happens. This only matters the very first time a day
  is solved — every later call already carries that residue forward as part
  of `existing`, by the same convention every other anchor relies on.
- **Today's eligible catalog** is assembled by filtering the caller's
  catalog down to activities that are enabled and whose allowed weekdays
  include today, then appending one reconstructed pseudo-activity for every
  ad-hoc instance still present in `existing` (an ad-hoc has no catalog
  entry of its own, so without this step it would simply vanish the moment
  any event other than the one that created it re-solved the day).
- **Per-instance rule overrides are re-applied on top of that catalog,
  unconditionally, before any event handler runs.** If an existing instance
  carries a rule tagged as coming from the instance itself rather than its
  template (the mechanism `EDIT_INSTANCE_RULES` writes — Section 14),
  that rule replaces the template's rule of the same type for this solve
  only. This durability step running before every dispatch, rather than
  only when handling the edit event itself, is what makes an override
  survive an arbitrary sequence of later `TICK`s, skips, and so on without
  the caller ever having to replay it.

The result of this setup, "today's catalog," is what every phase below
operates over — it already reflects ad-hoc activities and instance-level
overrides as if they had always been part of the template.

## 4. Anchors: what a re-solve is not allowed to touch

Every event after the first solve of a day re-solves *something*, but never
everything. An **anchor** is an existing instance that the upcoming
re-solve must leave completely untouched, for one of two reasons: it has
already consumed real time (its state is `ACTIVE`, `COMPLETED`, or
`CARRIED_IN`), or an earlier event pinned it explicitly regardless of state
(its `locked` flag — currently only set by a user-initiated `SKIP`, so that
a skip survives later ticks until a matching `RESTORE` lifts it).

Extracting the anchor set for a given snapshot of `existing` produces four
things: the anchor instances themselves (echoed into the final result
verbatim), the set of activity ids they cover (excluded from fresh
candidate generation), the time intervals they occupy (fed into the
placement search as pre-existing occupancy, exactly like a block that was
already placed earlier in the same phase), and a lookup of anchor
placements by activity id (used later so a guest activity can still nest
into a host that is itself anchored — e.g. editing an already-`ACTIVE`
host's overlap rule to admit a new guest).

Two details of how this set is built matter for correctness:

- A **chunked activity is never treated as an anchor**, even if some of its
  fragments have already started or completed. Partial completion of a
  chunk plan across events is not modeled; a chunked activity is always
  re-solved fresh from its template on every re-solve, discarding whatever
  fragment already ran. This is a deliberate scope boundary, not an
  oversight — the same simplification recurs for chunked hosts in the
  overlap and sequence phases below.
- An **ad-hoc anchor has no `activityId`**, since it was never part of a
  catalog. Anywhere the engine needs a stable key for "this activity /
  instance is already spoken for," it falls back to the instance's own id
  when `activityId` is null. This same fallback key is also how a later
  event finds *every* fragment of a chunked plan (all fragments share an
  activity id) or a single ad-hoc instance (which has none) when it needs
  to act on "the whole thing" rather than one instance row.

## 5. The core placement search (shared machinery)

Three phases below (fixed, hard-set, greedy) and every shrink/chunk/overlap
variant of them are all built out of the same small set of primitives.
Understanding these once explains most of the solver's behavior.

**Free space.** At any point in the pipeline, "what's still open" is
computed by taking the day's full span, subtracting every interval already
known to be occupied (merging overlapping or touching occupied intervals
first), and returning what's left as a list of maximal open intervals. This
is recomputed fresh every time something new gets placed — there is no
incrementally-maintained free-space structure, just a cheap recomputation
from the current occupied list.

**Candidate starts.** Given a duration and a set of free intervals, a
candidate start time is any point inside a free interval that both lands on
a grid boundary (a multiple of the configured grid size, 5 minutes by
default) and leaves enough room before that interval's end for the full
duration to fit. Every phase generates its candidate positions this way;
none of them consider off-grid placements.

**Window feasibility and drift.** A candidate `[start, end)` is checked
against whichever window rule the activity carries, if any:

- No window rule: any candidate is feasible, with zero drift.
- A strict window: feasible only if the candidate falls entirely inside the
  window; there is no such thing as "a little outside" for a strict window.
- A flexible window: the candidate may extend outside the window on either
  side, up to the rule's allowed drift *in total*. The amount of drift a
  candidate incurs is the sum of however many minutes of the candidate fall
  before the window's start and however many fall after its end, each
  capped so a candidate that lies entirely off to one side isn't
  double-counted past its own duration. A candidate is only feasible if
  that total does not exceed the rule's allowance.

One consequence worth being explicit about: for a flexible-window candidate
that lies entirely outside the window (no overlap with it at all), the
drift is not "distance from the window" — it collapses to the candidate's
own full duration, because the entire candidate counts as being on one side
of the window. A flexible window with a small drift allowance therefore
effectively also enforces a degree of proximity to the window, not just
partial overlap.

**Cost and ranking.** Every candidate placement is priced (Section 8
details the exact formula) and candidates are always ranked cheapest
first. Where two searches genuinely tie on cost, the implementation's
tie-breaking is not perfectly uniform across every search function, but the
consistent pattern is: prefer the candidate that schedules more of the
activity's full duration, then prefer the earlier start time. A few
narrower internal searches (the single-block shrink ladder, the overlap
nesting search) only implement this indirectly, by searching from the
longest candidate length down to the shortest and only replacing the
current best on a *strictly* cheaper find — which has the same practical
effect (a tie is resolved in favor of whichever length was tried first,
i.e. the longer one) without an explicit three-way sort.

## 6. Phase 1a — Fixed placement

Every activity carrying a `FixedRule` is placed at its declared wall-clock
time, unconditionally — this is the only phase with no search at all. A
`FixedRule` whose end is not after its start is interpreted as spanning
midnight: its end is resolved against *tomorrow's* day frame rather than
today's (so a transition-night's different length doesn't silently distort
an overnight block), and its placement's end offset is expressed relative
to today's frame by adding today's own length to that overflow.

Two things make a fixed placement fail outright rather than search for an
alternative, since a declared exact time is never subject to the ordinary
free-space search other phases use:

- It collides with another fixed activity's declared time.
- It collides with time already claimed by an anchor (a carry-in block is
  the most common case — nothing may ever be scheduled before a carry-in
  block from the previous day ends), or it starts before the freeze
  boundary for this solve.

Every fixed activity involved in any such collision — not just one of the
pair — is marked infeasible with a blocking diagnostic; the engine never
picks an arbitrary winner between two colliding fixed activities. This is
also the only phase whose diagnostics can force the whole timeline's status
to `DEGRADED` on their own, independent of what the rest of the pipeline
finds.

## 7. Phase 1b — The hard set (bounded backtracking)

The remaining mandatory activities — `MandatoryRule` without a `FixedRule`
— are placed next, as a group, with backtracking: unlike every later phase,
this one is allowed to reconsider an earlier commitment if a later
activity in the group turns out to have no room left.

**Ordering.** Before searching, the mandatory activities are sorted
most-constrained first: whichever has the fewest feasible candidates
(evaluated against only the fixed placements and anchors already settled,
before any other mandatory activity has claimed anything) goes first, ties
broken by priority rank. This is the classic "fail fast, backtrack less"
heuristic — an activity with almost no options is far more likely to be the
one that eventually forces a backtrack, so it's better to discover that
immediately rather than after several easier activities have already
consumed the room it needed.

**Candidates.** For each activity, the candidate list spans its entire
shrink ladder if it has one (Section 10) — every length from its full
duration down to its shrink floor, in grid steps — not just its full
duration. This means the hard set can accept a shrunk placement for a
mandatory activity rather than failing it outright, and a mandatory
activity's own shrink floor effectively becomes its true "must fit this
much" requirement for backtracking purposes.

**The search itself** is an explicit, iterative backtracking loop over the
ordered list (not a recursive one): a cursor walks forward through the
list; at each activity, its candidate list (computed against whatever is
currently occupied, including every commitment made so far by earlier
activities in the order) is generated once and remembered; the loop takes
the next untried candidate from that list, commits to it, and advances the
cursor. If every candidate for the activity at the cursor is exhausted, the
loop backtracks: it discards the previous activity's commitment, advances
that activity's own attempt counter by one, and resumes the search from
there — trying that previous activity's *next* candidate instead. Reaching
the front of the list with no earlier commitment left to blame means that
activity is infeasible in isolation.

This process is bounded by a node limit (a fixed budget on how many
placement attempts the whole hard set is allowed to make in total). If the
budget is exhausted mid-search, every activity from the current cursor
onward that hasn't already been placed is simply marked infeasible and the
search stops — this is a safety valve against pathological catalogs with
many interacting mandatory constraints, not a claim that those activities
are truly unplaceable.

## 8. The cost model

Every placement decision from here on is made by comparing costs, so the
formula is worth stating precisely.

**Priority weight.** Each activity's weight is `(total ranked activities in
the full catalog) + 1 − (its priority rank)`. Rank 1 — the highest
priority — gets the largest weight; every relaxation and skip cost below is
multiplied by this weight, so the same shrink or the same skip costs
strictly more for a higher-priority activity than a lower-priority one.

**One candidate's cost** (used to compare alternative placements for a
single activity) sums four weighted terms: how many minutes of the
activity's full duration went unscheduled (multiplied by the shrink unit
cost), one unit of chunk cost for every chunk beyond the first, the number
of drift minutes the candidate incurs (per the window-feasibility
calculation above), and the number of minutes of gap it introduces (only
relevant for a sequence dependent's placement). A whole, unshrunk,
un-drifted, adjacent-with-no-gap placement therefore costs exactly zero —
it's the free baseline every relaxation is priced against.

**Skipping** an activity entirely costs its weight times a large fixed skip
unit — except a mandatory activity, for which skipping costs infinity (it
must never be chosen over any legal placement, however expensive), and a
sequence dependent whose skip is purely a consequence of its own host
having been skipped, which costs nothing (the dependent didn't do anything
wrong; it simply had nothing left to attach to).

**The whole timeline's cost** is not just a sum of each instance's own
number — it's recomputed from the finished instance list by grouping
fragments that share a chunk-group id back into one logical activity first
(so a two-chunk plan's shrink shortfall and chunk penalty are counted once
for the pair, not once per fragment), then summing each group's
skip/shrink/chunk/drift/gap contribution, plus a separate idle term: the
total number of minutes in the day not covered by any top-level (non-guest)
instance, at a small per-minute cost. This idle term is the only cost
component that isn't about any single activity — it exists purely to make
"schedule something, anything" cheaper than "leave the day empty," all else
equal.

A catalog-level sanity check (surfaced through `validateActivity`, not the
solver itself) verifies a **dominance invariant**: for every activity, the
cost of its worst legal relaxation (maximum shrink, maximum chunk count if
allowed, maximum drift, maximum sequence gap, each independently — not
combined) should still come in strictly cheaper than simply skipping it.
An activity that fails this check is one the solver might needlessly skip
even though relaxing it was cheaper and available — a modeling mistake in
the catalog, not something the solver corrects for on its own.

## 9. Phase 2 — Greedy placement

Every remaining activity that isn't fixed, mandatory, or a sequence
dependent is placed here, one at a time, in ascending priority-rank order,
with **no backtracking**: once an activity is placed, nothing placed after
it can ever displace it. This is what makes phase 2 fast — it's a single
pass — at the cost of being locally rather than globally optimal: a
lower-priority activity's placement is only ever chosen given the day as
higher-priority activities already left it, never the other way around.

For each activity, in order, the engine computes two independent
candidates and takes whichever is cheaper:

1. **The ordinary free-space result** — its cheapest legal placement (or
   shrink, or chunk plan — Section 10's shrink/chunk search below) against
   whatever is currently free, exactly as phase 1b would search for it, but
   without backtracking.
2. **A nested candidate**, if this activity is listed as an allowed guest of
   any host activity that is *already placed* at this point in the pass. An
   activity is only available as a nesting host once its own top-level
   placement has actually been committed — a host processed later in
   ascending-rank order, or one that never gets placed at all, simply isn't
   available yet. This single rule is the entire mechanism behind an
   observed edge case: a guest that outranks its own host (i.e. is
   processed before it) can never nest into it, because the host isn't in
   the placed-hosts lookup yet when the guest's turn comes.

If a nested candidate exists and is at least as good as the free-space
result failing outright, or strictly cheaper than it succeeding, the guest
is placed nested inside its host (recorded against the host's id, and
counted toward that host's shared time budget for any later guest) instead
of occupying its own slot in the day's free space — a nested guest does not
reduce the free time available to activities placed afterward, since it
occupies time that was already claimed by its host.

Guest nesting is intentionally scoped to single-block guests only: a guest
that itself carries a chunking `ShrinkRule` is not split across a host's
available regions, and a guest that is itself hosting further guests (i.e.
nesting two levels deep) is not supported — neither combination is
exercised by any worked scenario the engine was built against.

## 10. Shrink and chunking search

An activity with a `ShrinkRule` is searched two ways, and the cheaper of
the two wins — with the important asymmetry that **a tie favors the
single-block result over a chunked one**, so chunking only ever wins when
it's genuinely, strictly cheaper.

**The single-block ladder** tries the activity at its full duration first,
then progressively shorter lengths in grid steps down to the rule's floor,
searching for the cheapest legal placement at each length and keeping the
best found across the whole ladder. Because it walks from longest to
shortest and only replaces its current best on a strict improvement, a tie
between two lengths is resolved in favor of the longer one — consistent
with the general tie-breaking pattern described in Section 5.

**The chunk search** (only attempted if the rule allows chunking) tries
every chunk count from 2 up to the rule's maximum, independently, and keeps
whichever count produces the cheapest plan that still reaches at least the
shrink floor in total. For a given chunk count, the plan is built greedily:

1. Every candidate free region is first clipped to whatever window rule
   bounds the activity (a strict window's own bounds, or a flexible
   window's bounds extended by its drift allowance on each side) — an
   unclipped region could otherwise hide a window-sized opportunity deep
   inside a much larger free interval, in a way that later steps'
   region-level reasoning wouldn't see.
2. Every clipped region is ranked by the lowest drift it can offer at its
   own best achievable size, ties broken by preferring a larger region and
   then an earlier one.
3. The top-ranked regions, up to the chunk count being tried, are selected.
4. Minutes are then greedily assigned into the selected regions in that
   ranked order. Each region is capped not just by its own size but by a
   reservation: enough must be held back so that every region still to come
   in the selection can still receive at least the minimum chunk size — an
   early, large region grabbing everything available would otherwise
   silently prevent a split that should have existed (for instance, two
   equal 60-minute regions splitting a 120-minute target evenly). A region
   that the reservation leaves with less than the minimum chunk size simply
   contributes nothing rather than failing the whole plan.
5. The process stops once the target total is reached or the selected
   regions are exhausted. Reaching less than the target is an accepted,
   valid outcome — a chunked plan is only rejected afterward if its total
   still falls short of the shrink floor. This mirrors the single-block
   ladder's floor requirement: however an activity gets shrunk, whether as
   one block or several chunks, however much *is* scheduled must still meet
   the same minimum.

## 11. Overlap: nesting a guest inside a host

Given an already-placed host and one candidate guest, the nested search
first checks the host's remaining shared time budget (its total budget
minus however much its already-nested guests have already consumed); if
none is left, or what's left can't even cover the guest's own shrink floor,
nesting is impossible immediately, without a further search.

Otherwise, the searchable region is the host's own span with two things
subtracted: its declared exclusion windows (which may be anchored either
relative to the host's own start, or to an absolute wall-clock time
regardless of where the host landed) and the spans already claimed by any
other guest already nested in it. Within that region, the guest's own
shrink ladder is searched exactly as in Section 10 — full duration (capped
by whatever budget remains) down to its floor — for the cheapest legal
candidate, and that becomes the nested candidate compared against the
guest's ordinary free-space result back in Phase 2.

An absolute-anchored exclusion window plays one further role, upstream of
nesting entirely: it's treated as a hard constraint on the *host's own*
placement search (in every phase, not just here) — the host itself is only
allowed to land somewhere that fully contains every absolute exclusion
window it declares, since that window's wall-clock position doesn't move
with the host the way a relative one does.

## 12. Phase 2.5 — Sequence dependents

Activities carrying a `SequenceRule` (must run immediately before or after
another activity) are placed last, independent of priority rank, once
every possible host has a placement (or lack of one) resolved from the
earlier phases. A dependent that is itself `Fixed` is not treated as a
dependent at all here — a declared exact time already fully determines it,
so it's placed as an ordinary fixed host instead and the sequence
relationship has nothing left to solve.

Each host's resolution going into this phase is one of: the outer span of
its chunk plan if it was chunked (the dependent attaches to the plan's
overall earliest start / latest end, not to any individual chunk — treating
a multi-chunk host's own internal structure as relevant to a sequence
attachment is a known simplification, deferred until a scenario actually
combines the two features), its ordinary placement from fixed/hard-set/
greedy, or "skipped" if it has none.

Placement then proceeds in **rounds**, because a chain (one activity
sequenced after a second, which is itself sequenced after a third) can't
all resolve in one pass — the first link in the chain has to resolve before
the second link even knows where its own host landed. Each round scans
every still-unresolved dependent: if its host's resolution isn't known yet,
it waits for a later round; if its host resolved to "skipped," the
dependent is itself skipped for free, at zero cost — this is not a failure,
just a cascading consequence, and it's explicitly excluded from ever
triggering an event rejection later (Section 15); otherwise, the engine
searches for the cheapest adjacent slot by trying gaps of increasing size —
zero first, then one grid step, and so on up to the rule's maximum allowed
gap — placing the dependent immediately before or after the host's span
depending on its declared role, and accepting the very first gap size that
yields a legal, free, window-feasible candidate (since cost rises
monotonically with gap size, the first hit is always guaranteed to be the
cheapest). A dependent that finds no such slot at any gap size is skipped
for a genuine, non-free reason — it's the round-based resolution that lets
this dependent, once resolved (placed or skipped), itself unblock a further
dependent chained onto it in the next round.

Rounds continue as long as at least one dependent made progress in the
previous round. Anything still unresolved once a round makes no further
progress at all is skipped defensively — this should be structurally
impossible given that catalog validation independently rejects a genuine
cycle in the sequence graph before any of this runs, but the loop
terminates safely regardless rather than spinning forever if that
invariant is ever violated.

One further simplification worth naming: a host's own placement search
earlier in the pipeline has no awareness that a dependent is waiting on it
— it is never steered toward a slot that would leave room for its
dependent. A host is placed purely on its own merits; only afterward does
its dependent try to fit next to wherever it landed. This diverges from
what a fully joint optimization would do, but only in the (rare) case where
a host's cheapest slot happens to leave no adjacent room while a slightly
costlier slot for the host would have.

## 13. Assembling the timeline

Once every phase above has produced its placements and skips, the engine
builds the actual list of instances that becomes the result:

- An activity that resolved to a single placement (whether from fixed,
  hard-set, greedy, or the sequence phase) becomes one instance carrying
  that placement.
- An activity that resolved to a chunk plan instead becomes *several*
  top-level instances — one per chunk, ordered by start time — all sharing
  one chunk-group identifier and each other's total chunk count, but with
  the *plan's* shrink and chunk-count relaxations recorded only once, on
  the first chunk, specifically so that reading the relaxation back out of
  the instance list later doesn't double-count a group-level cost as if it
  applied to every fragment individually.
- An activity that resolved to neither becomes a single skipped instance,
  carrying whichever specific skip reason the phase that gave up on it
  determined (no free space, a window that couldn't be satisfied even
  after drift, a budget that ran out, its host being skipped, not being
  allowed on today's weekday, or a user's explicit skip).
- A sequence dependent that ended up with both a placement and a
  gap-relaxation from its own phase carries that gap relaxation *alongside*
  whatever shrink/drift relaxation its own placement search would otherwise
  have recorded for it — the two are independent and both apply if both
  occurred.

Separately, a lightweight diagnostics pass scans the finished instance list
and reports, per instance: a blocking diagnostic (forcing the whole
timeline's status to degraded) for any mandatory activity that still ended
up skipped for lack of room; an informational note for any activity that
had to be shortened; and a separate informational note for any activity
that had to be split into chunks. These are advisory only — they explain a
result that has already been finalized, not a constraint the assembly step
enforces.

The overall timeline status is `DEGRADED` if either the fixed-placement
phase reported any collision at all, or the diagnostics pass above found a
mandatory activity it couldn't place; otherwise it's `OK`. A day is always
fully assembled and returned regardless of status — degradation is a
description of the result, never a reason to refuse to produce one.

## 14. The event layer

Every event that isn't `GENERATE_DAY`, `TICK`, or `FINALISE_DAY` targets one
specific existing instance and follows the same shape, implemented
separately (and largely duplicated) per event rather than through one
shared generic step. `ADD_ADHOC` is the one exception to steps 1–2 below —
it has no existing instance to look up at all, since it's creating one;
its "precondition check" is validating the new payload instead (Section
17) — but it rejoins the same shape from step 3 onward:

1. Look up the targeted instance by id in the caller's `existing` list;
   fail immediately if it isn't there.
2. Check that instance's current state and any event-specific fields
   against exactly what that event requires (for example: a `SKIP` requires
   the target to currently be `PLANNED`; a `RESTORE` requires it to
   currently be `SKIPPED`; an `EXTEND` requires it to be `ACTIVE` and its
   requested extension to be a positive, grid-aligned number of minutes);
   fail immediately if the precondition doesn't hold.
3. Build a working version of `existing` that reflects the event having
   already happened — the target instance mutated in place (marked
   skipped, marked completed early, given a new planned end, etc.), or, for
   `ADD_ADHOC`, a brand-new instance and a freshly constructed pseudo-
   activity added to the mix.
4. Extract the anchor set from that working state (Section 4), which
   determines both what gets excluded from re-solving and what occupied
   time the re-solve must respect.
5. Run the full placement pipeline (Sections 5–13) over everything that
   isn't anchored, at whatever freeze boundary is appropriate for this
   event (ordinarily `now`; for `FINISH_EARLY`, the earlier completion time
   itself, so the newly-freed time between it and the old planned end is
   immediately available to the rest of the day).
6. Combine the anchors, the freshly solved instances, and any handler-
   specific extra instance into one full instance list, wrap it into a
   complete speculative result (recomputing the whole-timeline cost from
   scratch against this new instance list), and tentatively advance the
   revision number by one.
7. Compare that speculative result against the instance list as it stood
   *before* the event (Section 15). If the comparison finds the event
   introduced a genuine regression, the speculative result is discarded
   entirely and the event is rejected — the caller gets back the original,
   completely unchanged timeline (same revision, recomputed diagnostics and
   cost against the *unchanged* instances), plus a description of what went
   wrong and, for reference, the discarded speculative timeline showing
   what would have happened. Otherwise the speculative result is returned
   as the new timeline.

What differs per event is almost entirely contained in steps 2 and 3:

- **`TICK`** doesn't target a specific instance at all. It first applies
  automatic state transitions to every instance based purely on `now`: a
  `PLANNED` or `ACTIVE` instance whose entire planned span has already
  passed becomes `COMPLETED` (tagged as backdated rather than user-driven);
  a `PLANNED` instance that `now` currently falls inside becomes `ACTIVE`.
  If nothing at all changed state, the call stops right there and returns
  the input completely unchanged, including its revision number — this is
  what makes calling `TICK` repeatedly with the same `now` free of any
  cumulative effect. Only if something did change does it proceed through
  steps 4–7 as normal, with every newly-backdated instance now counting as
  an anchor for the re-solve.
- **`GENERATE_DAY`** skips the "did anything change" short-circuit
  entirely (there's nothing to compare against on a brand-new day) and
  always produces a fresh solve, starting the day at revision 1.
- **`SKIP`** marks the target `PLANNED` instance skipped with a
  user-attributed reason and, critically, marks it `locked` — which is what
  makes `extractAnchors` continue treating it as untouchable (with no
  occupied time, since it no longer has one) across any number of later
  `TICK`s, unlike an ordinary automatic skip that a later re-solve is free
  to reconsider.
- **`RESTORE`** is almost the mirror image: it simply stops treating the
  previously-locked instance as an anchor and lets its activity compete for
  a placement again like any other candidate. If there's genuinely no room,
  it can come back skipped again, possibly for an entirely different
  reason — that alone is not a rejection, since the activity being restored
  was already skipped beforehand and the rejection check only cares about
  regressions the event itself caused. What *can* legitimately get
  rejected here is a side effect: restoring one activity can shift where a
  higher-priority activity around it ends up, which can in turn break a
  sequence dependent that was previously sitting comfortably adjacent to
  something else entirely.
- **`FINISH_EARLY`** marks the target `ACTIVE` (or `CARRIED_IN`) instance
  completed at the given time — after checking that time actually falls
  between its real start and its originally planned end — and re-solves
  the remainder of the day with the freeze boundary pulled back to that
  earlier completion time rather than left at `now`. There is no separate
  "now go find something to do with the freed time" step: because
  everything not anchored is re-solved completely from scratch, an activity
  that had previously been shrunk or skipped for lack of room can end up
  placed at full length simply because the ordinary search now finds more
  room than it did before.
- **`EXTEND`** pushes the target `ACTIVE` instance's planned end further
  out by the requested (grid-aligned) number of minutes and re-solves the
  remainder at the ordinary freeze boundary — anything scheduled after it
  may have to nudge, shrink, or drop as a consequence, each such change
  carrying its own diagnostic from the assembly step.
- **`ADD_ADHOC`** constructs a brand-new pseudo-activity from the caller's
  payload (its id derived from how many ad-hoc activities already exist,
  keeping id generation deterministic without reading a clock or a random
  source), validates it exactly as if it were a real catalog entry
  (incompatible rules, off-grid values, a colliding priority rank against
  something already in the catalog), and — if valid — adds it to the
  activities being solved this round. Because introducing a new activity
  changes the total count used for priority weighting, this event
  recomputes every activity's weight against the new, larger total for this
  one solve, rather than reusing the weight the rest of the day was
  computed with.
- **`EDIT_INSTANCE_RULES`** replaces one or more rule types on the target's
  *template*, for today only, by constructing a modified copy of that
  activity with the new rules substituted in (and tagged as coming from the
  instance, not the template) and validating that modified copy exactly
  like any other activity. If the edited instance happens to be currently
  anchored (for example, editing an already-`ACTIVE` activity's overlap
  rule to admit a new guest), its rules are patched in place on the anchor
  itself too, since the anchor is what a later solve reads back — this is
  the other half of the durability mechanism described in Section 3; the
  instance-level rule persists because every later solve's setup step
  re-derives the effective catalog from exactly this kind of tagged rule.

## 15. Detecting a regression (event rejection)

The comparison that decides whether to reject an event works by comparing
"before" (the instance list exactly as the caller passed it in) against
"after" (the freshly solved speculative result), matched up by activity id.
It looks specifically for an activity that is skipped *after* the event but
was **not** already skipped *before* it — an activity already skipped
beforehand staying skipped, or getting skipped for a different reason,
never counts on its own, because the event didn't cause that; it was
already true.

For the first such newly-introduced skip it finds, it classifies the
rejection by *why* that activity is now unplaceable:

- No free space or window could be found at all, and the activity is
  mandatory (or the same holds for a fixed activity, whose declared time
  now genuinely collides with something else): rejected as either a
  mandatory-placement failure or a fixed-time collision, depending on which
  kind of hard constraint the activity actually carries.
- Its window can no longer be satisfied: rejected as a strict-window
  violation, or, if the instance had been nested inside a host whose own
  position moved, specifically as a guest-window violation instead — the
  distinction matters because the natural fix is different (move the guest
  vs. reconsider the host).
- A sequence dependent that can no longer find an adjacent slot: rejected
  as a sequence failure — but *only* if its host is not itself now skipped.
  A dependent losing its slot purely because its own host vanished is a
  cascading, zero-cost, and entirely expected consequence (Section 12), not
  a regression the event should be blamed for.

Every other newly-observed skip — most notably an ordinary discretionary
activity simply losing out on space to something else — is not a rejection
at all; it's accepted as part of the speculative result and shows up as an
ordinary, `DEGRADED`-flavored consequence of the event instead. This
distinction — a "hard" invariant being broken versus an activity merely
losing a competition it was always exposed to losing — is what separates
an event that fails loudly from one that simply degrades and explains
itself, and it is evaluated identically regardless of which specific event
triggered the re-solve.

## 16. Ending a day (`FINALISE_DAY`)

This event bypasses the placement pipeline entirely — nothing is
re-solved, no new candidates are searched. It first requires that `now`
has actually reached the day frame's own length; otherwise it's rejected
outright as premature.

Given that, it applies the same automatic backdating `TICK` would, then
walks the resulting instance list once, looking for any instance that is
still `PLANNED` or `ACTIVE` and whose planned end genuinely overflows past
the day's length — the only two ways that happens are a `FixedRule` that
was declared spanning midnight, or an `EXTEND` that pushed an active
instance's end past the boundary. Anything else still unfinished at this
point is left exactly as it is in today's own record; nothing is inferred
or carried forward for it. For a genuinely overflowing instance, today's
own copy is clamped to end exactly at the day boundary, and the overflow
portion becomes a brand-new, separate instance — marked `CARRIED_IN` and
already `locked` — occupying the very start of what will become tomorrow's
day frame. That carry-in list, handed back to the caller, is the *only*
piece of state that ever crosses from one day frame into the next; the
engine itself retains nothing.

Once this succeeds, the day's own `finalised` flag is set on the resulting
timeline, and the top-level entry point refuses every subsequent event
against a day frame the caller marks as already finalised, unconditionally
and before any other logic runs — a finalized day cannot be reopened by any
event, including another attempt to finalize it.

## 17. Catalog validation

Separately from solving, two pure checks exist purely to catch a malformed
catalog before it's ever handed to `solve()` (and are reused internally
whenever an event introduces new or modified rules — adding an ad-hoc
activity, or editing an instance's rules — so the same checks apply
uniformly whether the mistake originates from a caller's static catalog or
from a live edit).

Checked per activity, independent of any other activity in the catalog: no
two rules of the same type may coexist on one activity, nor may certain
specific pairs coexist even though they're different types (a fixed time
combined with either kind of window, or with a shrink rule, since a fixed
block has nothing left to shrink or fit); every duration and every
wall-clock rule boundary and every shrink floor/minimum-chunk value must
land exactly on a grid boundary; a shrink floor may not exceed the
activity's own full duration, nor may its minimum chunk size exceed the
floor; a strict or flexible window's end must fall strictly after its
start. Beyond hard errors, two conditions are flagged as likely mistakes
without being blocked outright: a strict window narrower than the
activity's own duration with no shrink rule to make up the difference (such
an activity can never be placed, ever), and a flexible window whose gap
from the activity's duration exceeds the allowed drift (some drift is then
mathematically guaranteed no matter where it lands). The dominance
invariant from Section 8 is checked here too, as is a simple warning for an
activity with no allowed weekdays at all (it will simply never appear).

Checked across the whole catalog at once: no two activities may share a
priority rank; no two activities may both claim to be, say, the "pre"
partner of the same host (a host may have at most one pre and one post
partner); the sequence graph these `linkedActivityId` references form must
not contain a cycle — detected by walking each activity's chain of links
and watching for a link that revisits a node still on the current walk's
path, at which point every activity from that repeated node onward in the
path is flagged as part of the cycle; and, as a warning rather than an
error, any guest activity whose priority rank is numerically better than
its declared host's rank is flagged, since — per the greedy phase's
ascending-rank ordering described in Section 9 — such a guest is always
processed and placed before its host even has a placement to nest into,
meaning the nesting relationship declared for it can never actually trigger.

## 18. Rendering

`renderAscii` is pure formatting with no search or decision-making of its
own: it separates top-level (non-guest) instances into placed (sorted by
start time) and skipped (sorted by priority rank), lists each placed
instance's guests immediately beneath it (sorted by their own start time),
annotates any relaxations inline, and appends the timeline's already-
computed cost breakdown and status at the end. Every byte of its output is
derived solely from the `Timeline` value it's given — nothing reads the
system clock or generates an id — which is what makes it safe to use as a
deterministic snapshot in a test.
