# Dynamic Day Scheduler — Public API

This is the "how do I call it" reference for the engine. It describes the
surface exported from `@balanced/brain` — the only module callers should
import from. `src/engine/*` is implementation detail (placement
search, backtracking, cost internals) and is not a supported import path
outside `src/engine` itself. For the full behavioral spec (why the
solver does what it does), see `SPEC.md`; this document only
covers how to call it.

```ts
import {
  activity,
  resolveDayFrame,
  solve,
  validateCatalog,
} from "@balanced/brain"
```

## Mental model

`solve()` is a pure function: `(SolveInput) => SolveResult`. It never
mutates its input, performs no I/O, and takes `now` as an explicit argument
rather than reading the clock — the caller owns persistence and time.

There is one entry point for every user action. Loading the day, a clock
tick, finishing a task early, adding an ad-hoc activity, skipping something
— each is an `Event` fed through the same `solve()` call. There is no
separate "apply an update" API, and no second validation path: an event is
validated by speculatively solving it and inspecting the result.

The typical loop:

```
previous result.timeline.instances ──┐
                                      ├─▶ solve({ ...,  event }) ─▶ new SolveResult
                    new Event ────────┘
```

Each call's `result.timeline.instances` becomes the next call's `existing`.

## Quick start

```ts
import {
  activity,
  resolveDayFrame,
  solve,
  validateCatalog,
} from "@balanced/brain"

const dayFrame = resolveDayFrame("2026-07-27", "America/New_York")

const catalog = [
  activity("Gym")
    .rank(1)
    .minutes(60)
    .flexible("18:00", "20:00", { drift: 15 })
    .build(),
  activity("Standup").rank(2).minutes(15).fixed("09:00", "09:15").build(),
]

const issues = validateCatalog(catalog) // surface template mistakes before solving
if (issues.some((i) => i.severity === "error")) {
  // don't solve a catalogue with structural errors
}

const result = solve({
  dayFrame,
  now: 0, // minutes since local midnight
  catalog,
  existing: [], // yesterday's finalised state, or [] for a fresh day
  carryIn: [], // midnight-spanning residue from yesterday, if any
  event: { type: "GENERATE_DAY" },
})

result.status // "OK" | "DEGRADED" | "REJECTED"
result.timeline.instances // the schedule
result.timeline.diagnostics // warnings/explanations (shrinks, chunks, skips)
result.timeline.cost // cost breakdown, for comparing alternatives
```

Every subsequent call passes the previous `result.timeline.instances` back
in as `existing`, with a new `event`:

```ts
const ticked = solve({
  dayFrame,
  now: 90,
  catalog,
  existing: result.timeline.instances,
  carryIn: [],
  event: { type: "TICK" },
  revision: result.timeline.revision,
})
```

At end of day, send `{ type: "FINALISE_DAY" }` and carry
`result.timeline.carryIn` into tomorrow's `carryIn` argument. `finalised`
must then be passed as `true` on any further call against that day frame —
the engine rejects further events against a finalised timeline with
`SPANS_FROZEN_REGION`.

---

## Building a catalog: `activity()` / `ActivityBuilder`

`activity(name)` starts a fluent builder for an `Activity` template — the
recommended way to construct catalog entries without hand-assembling the
`Rule` union. State only the properties a given activity needs; the rest
take sensible defaults (30-minute duration, every weekday, enabled).

`.rank(n)` is the only required call — `.build()` throws
`activity "<name>" is missing .rank(n)` if it was never set.

```ts
const gym = activity("Gym")
  .rank(2)
  .minutes(60)
  .flexible("18:00", "20:00", { drift: 15 })
  .shrink({ floor: 30 })
  .build()
```

| Method                                                 | Adds                 | Notes                                                                                                                                                    |
| ------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.id(id)`                                              | —                    | Overrides the auto-generated (slugified-name) id                                                                                                         |
| `.rank(n)`                                             | —                    | **Required.** Priority rank for cost weighting and hard-set ordering — lower wins ties                                                                   |
| `.minutes(m)`                                          | —                    | Full, unshrunk duration. Default `30`                                                                                                                    |
| `.days(...days)`                                       | —                    | Restricts eligible weekdays (`Weekday`). Default: every day                                                                                              |
| `.disabled()`                                          | —                    | Excludes the activity from solving entirely                                                                                                              |
| `.fixed(start, end)`                                   | `FixedRule`          | Immovable wall-clock span; may span midnight                                                                                                             |
| `.strict(start, end)`                                  | `StrictWindowRule`   | Must be placed entirely inside the window, no drift                                                                                                      |
| `.flexible(start, end, { drift? })`                    | `FlexibleWindowRule` | Preferred window; may drift outside by `drift` minutes (default `0`)                                                                                     |
| `.mandatory()`                                         | `MandatoryRule`      | Placed via bounded-backtracking hard-set search instead of the greedy pass                                                                               |
| `.shrink({ floor, chunking?, minChunk?, maxChunks? })` | `ShrinkRule`         | Permits shrinking to `floor` minutes and/or splitting into `minChunk`-minute-or-larger chunks (up to `maxChunks`, default `3`) when it doesn't fit whole |
| `.sequence(role, linkedActivityId, { maxGap? })`       | `SequenceRule`       | Must run immediately before (`"pre"`) or after (`"post"`) another activity, within `maxGap` minutes (default `0`)                                        |
| `.overlap({ budget, guests, exclusions? })`            | `OverlapRule`        | May host the listed guest activity ids nested inside it, within a time budget                                                                            |
| `.build()`                                             | —                    | Returns the immutable `Activity`. Throws if `.rank()` wasn't called                                                                                      |

Rule compatibility and other structural mistakes are not checked by the
builder itself — run `validateActivity`/`validateCatalog` (below) before
solving.

You can also `new ActivityBuilder(name)` directly; `activity(name)` is just
a shorthand factory for it.

---

## Pre-flight checks: `validateActivity` / `validateCatalog`

Pure predicates over a catalogue, independent of any day or solve. They
return an array of `ValidationIssue` and never throw — call them before
`solve()` to catch template mistakes early, not to gate the solve itself
(the solver already handles infeasibility at solve time via `DEGRADED` or
`REJECTED`).

```ts
validateActivity(activity: Activity, constants: CostConstants): ValidationIssue[]
validateCatalog(activities: readonly Activity[]): ValidationIssue[]
```

- `validateActivity` checks one template in isolation (rule compatibility,
  grid alignment, shrink-floor validity, window sanity, the dominance
  invariant). It needs `constants` because grid alignment and the dominance
  check are constant-dependent — pass `DEFAULT_COST_CONSTANTS`, or whatever
  overrides you plan to pass to `solve()`.
- `validateCatalog` checks cross-activity invariants (duplicate ranks,
  sequence cycles/multiples, a guest outranking its host) and internally
  calls `validateActivity` for every activity, so calling `validateCatalog`
  alone is enough for a full pre-flight check.

```ts
const issues = validateCatalog(catalog)
const errors = issues.filter((i) => i.severity === "error")
const warnings = issues.filter((i) => i.severity === "warning")
```

`severity: "error"` means don't proceed to `solve()` with this catalogue.
`severity: "warning"` is legal but almost always a mistake worth surfacing
to whoever authored the catalogue (e.g. `NO_ALLOWED_DAYS`,
`GUEST_OUTRANKS_HOST`). Full code tables: SPEC.md Section 10.1.

---

## Driving the solver: `solve()`

```ts
function solve(input: SolveInput): SolveResult
```

### `SolveInput`

| Field        | Type                          | Notes                                                                       |
| ------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `dayFrame`   | `DayFrame`                    | From `resolveDayFrame()`                                                    |
| `now`        | `number`                      | Minutes since local midnight (the day frame's start)                        |
| `catalog`    | `readonly Activity[]`         | Never mutated or written to by the engine                                   |
| `existing`   | `readonly TimelineActivity[]` | The previous call's `timeline.instances`, or `[]` to start fresh            |
| `carryIn`    | `readonly TimelineActivity[]` | Midnight-spanning residue from yesterday's `FINALISE_DAY`, or `[]`          |
| `event`      | `Event`                       | The one thing this call is doing — see below                                |
| `constants?` | `Partial<CostConstants>`      | Overrides any subset of `DEFAULT_COST_CONSTANTS`                            |
| `options?`   | `SolveOptions`                | `{ trace?: boolean }` — attaches a `SolveTrace` to the result for debugging |
| `revision?`  | `number`                      | Echo of `existing`'s revision; a no-op `TICK` returns it unchanged          |
| `finalised?` | `boolean`                     | Pass `true` once a prior `FINALISE_DAY` closed this day frame               |

### `SolveResult`

| Field         | Type                               | Notes                                                                    |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `status`      | `"OK" \| "DEGRADED" \| "REJECTED"` | See below                                                                |
| `timeline`    | `Timeline`                         | The new schedule (or, on `REJECTED`, the _input_ timeline, unchanged)    |
| `rejection`   | `RejectionError \| null`           | Non-null only when `status === "REJECTED"`                               |
| `diagnostics` | `readonly Diagnostic[]`            | Same as `timeline.diagnostics`, exposed at the top level for convenience |
| `cost`        | `CostBreakdown`                    | Same as `timeline.cost`                                                  |
| `trace`       | `SolveTrace \| null`               | Present only when `options.trace` was set                                |

**`status` meanings:**

- **`OK`** — every activity that could reasonably be placed, was.
- **`DEGRADED`** — the day is still fully solved and returned, but something
  had to give (an activity was auto-skipped, shrunk, or drifted) and
  `diagnostics` explains why. This is normal, not an error — a day must
  always be producible, even a bad one.
- **`REJECTED`** — the requested _event_ would make things strictly worse
  than before it (see rejection codes below). `timeline` is the untouched
  input; nothing was mutated. This only happens for events that represent a
  user's explicit intent (e.g. `EXTEND`, `ADD_ADHOC`, `RESTORE`) — events
  that merely represent the passage of time (`GENERATE_DAY`, `TICK`) always
  degrade instead of rejecting.

**Rejection is a return value, not an exception.** There's no try/catch and
no separate "can I do this?" call — attempt the event and check
`result.status`.

### `Event`

One `Event` per `solve()` call:

| Event                                                | Effect                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ type: "GENERATE_DAY" }`                           | Build the day from scratch. Never rejected.                                                                                                                                                                                    |
| `{ type: "TICK" }`                                   | Advance to `now`: auto-start, auto-complete, backdating. Idempotent — calling it twice with the same `now` is a no-op the second time (revision doesn't advance).                                                              |
| `{ type: "FINISH_EARLY", instanceId, at }`           | Marks an `ACTIVE` instance completed at `at`, freezes everything up to `at`, and re-solves the remainder from scratch — freed time may be reused by something previously shrunk or skipped. Never rejected.                    |
| `{ type: "EXTEND", instanceId, minutes }`            | Pushes an `ACTIVE` instance's planned end out by `minutes` (must be a positive multiple of the cost grid) and re-solves the remainder; later blocks may nudge, shrink, or drop.                                                |
| `{ type: "ADD_ADHOC", payload }`                     | Adds a one-off `TimelineActivity` (`isAdhoc: true`, `activityId: null`) without touching `catalog`. `payload` carries the full rule vocabulary.                                                                                |
| `{ type: "EDIT_INSTANCE_RULES", instanceId, rules }` | Overrides one instance's rules for today only, without touching its template — e.g. temporarily letting an ad-hoc be a guest of today's Work block. The override persists across subsequent solves of the same instance.       |
| `{ type: "SKIP", instanceId }`                       | Marks a `PLANNED` instance user-skipped and frees its time. Never rejected.                                                                                                                                                    |
| `{ type: "RESTORE", instanceId }`                    | Lifts a user skip and re-solves the activity back in. Can reject — restoring one activity can legitimately displace and reject a different one (e.g. a sequence dependent).                                                    |
| `{ type: "FINALISE_DAY" }`                           | Requires `now >= dayFrame.lengthMinutes`. Backdates any residue, computes `timeline.carryIn` for tomorrow, sets `timeline.finalised = true`. Every further event against this timeline is rejected with `SPANS_FROZEN_REGION`. |

`AdhocPayload` shape: `{ name, durationMinutes, priorityRank, rules, date }`.

### Rejection codes (`RejectionError.code`)

Only meaningful when `status === "REJECTED"`. Comparison is always against
the _input_ timeline, not feasibility in the abstract — an activity already
skipped before the event doesn't trigger a rejection just because it's
still skipped after.

| Code                      | Condition                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIXED_COLLISION`         | Two fixed blocks would overlap                                                                                                                                                                              |
| `MANDATORY_UNPLACEABLE`   | A mandatory activity, previously placed, becomes skipped                                                                                                                                                    |
| `STRICT_WINDOW_VIOLATED`  | A strict-window activity, previously placed, becomes unplaceable                                                                                                                                            |
| `GUEST_WINDOW_VIOLATED`   | Moving a host pushes a nested guest outside its own strict window                                                                                                                                           |
| `SEQUENCE_UNSATISFIABLE`  | A sequence dependent can no longer be placed adjacently, and its host isn't itself skipped                                                                                                                  |
| `SPANS_FROZEN_REGION`     | The operation would alter a completed, carried-in, or finalised region                                                                                                                                      |
| `UNKNOWN_INSTANCE`        | `instanceId` isn't in `existing`                                                                                                                                                                            |
| `INVALID_STATE_FOR_EVENT` | The instance isn't in the state the event requires (e.g. `SKIP` on something not `PLANNED`), or an `ADD_ADHOC`/`EDIT_INSTANCE_RULES` payload is structurally invalid (bad rule combination, colliding rank) |

`RejectionError` also carries `message` (human-readable),
`conflictingInstanceIds`, `diagnostics` (the blocking diagnostics from the
discarded speculative solve), and `bestEffortTimeline` — what the rejected
solve _would_ have produced, free to inspect since it was computed anyway
(handy for "here's what would happen" previews).

---

## Time / day-frame helpers

```ts
resolveDayFrame(date: string, timezone: string): DayFrame
weekdayOf(date: string): Weekday
addDays(date: string, days: number): string
```

- **`resolveDayFrame`** turns a local calendar date (`"YYYY-MM-DD"`) and an
  IANA timezone into the `DayFrame` `solve()` expects. It's DST-aware:
  `lengthMinutes` is `1440` on a normal day, `1380`/`1500` across a spring-
  forward/fall-back transition. Always call this instead of hand-building a
  `DayFrame` — the UTC instant math around DST boundaries is not something
  to redo by hand.
- **`weekdayOf`** returns the `Weekday` for a date string, matching
  `Activity.allowedDays`'s vocabulary.
- **`addDays`** shifts a `"YYYY-MM-DD"` string by N days (calendar
  arithmetic, not a duration) — useful for stepping to tomorrow's
  `resolveDayFrame` call.

All engine times downstream of `dayFrame` (`now`, `plannedStart`, etc.) are
plain minute offsets from `dayFrame.startInstant`, not wall-clock strings —
convert to/from local time only at the display layer.

---

## Cost tuning: `DEFAULT_COST_CONSTANTS`

```ts
export const DEFAULT_COST_CONSTANTS: CostConstants = {
  SKIP: 10_000,
  SHRINK: 20,
  CHUNK: 200,
  DRIFT: 10,
  GAP: 5,
  IDLE: 1,
  GRID: 15,
  HARD_SET_NODE_LIMIT: 5_000,
}
```

Pass `constants: {...}` in `SolveInput` to override any subset — unset
fields fall back to these defaults. `GRID` also governs the alignment
checks in `validateActivity`/`validateCatalog`, so if you override `GRID`
for `solve()`, pass the same value when validating. Don't hand-roll a
constants object from scratch; spread over `DEFAULT_COST_CONSTANTS` so a
future default change doesn't silently regress an unrelated field.

---

## Debug / display: `renderAscii`

```ts
function renderAscii(timeline: Timeline): string
```

Deterministic ASCII rendering of a `Timeline` — placed instances in start
order, then skipped instances sorted by priority rank, each annotated with
its skip reason and any relaxations. Intended for logs and snapshot
assertions, not end-user UI.

---

## Types reference

All of the following are exported as types from `@balanced/brain` (they
mirror `src/engine/types.ts`, which is the source of truth if this
drifts):

**Rules & templates** — `Weekday`, `Rule`, `RuleType`, `RuleSource`,
`FixedRule`, `StrictWindowRule`, `FlexibleWindowRule`, `MandatoryRule`,
`ShrinkRule`, `SequenceRule`, `OverlapRule`, `ExclusionWindow`, `Activity`

**Solved schedule** — `DayFrame`, `TimelineActivity`, `InstanceState`,
`CompletedSource`, `SkipReason`, `RelaxationType`, `Relaxation`,
`Timeline`, `TimelineStatus`

**Diagnostics & cost** — `Diagnostic`, `DiagnosticSeverity`,
`CostBreakdown`, `CostConstants`

**Driving the solver** — `Event`, `AdhocPayload`, `SolveInput`,
`SolveOptions`, `SolveResult`, `SolveStatus`, `RejectionError`,
`RejectionCode`

**Validation** — `ValidationIssue`, `ValidationSeverity`

For the meaning behind these shapes (why a `TimelineActivity` has both
`plannedStart`/`plannedEnd` and `actualStart`/`actualEnd`, what
`chunkGroupId` is for, etc.) see SPEC.md Sections 3–8.

---

## What's deliberately not exported

Everything under `src/engine/` besides the files re-exported above
(placement search, backtracking, cost internals, the `resolve`/`greedy`/
`hard-set`/`sequence`/`overlap`/`shrink` modules) is an implementation
detail and may change shape without notice. If something you need isn't on
this page, that's a sign to extend `src/brain.ts`'s barrel rather
than reaching into `engine/*` directly.
