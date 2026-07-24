# Contract: Data-Access Layer (`lib/db/queries.ts`)

The **only** module permitted to issue Turso/libSQL queries (Constitution III). Server Actions and
Server Components import typed functions from here; nothing else opens a connection or writes SQL.
All functions take and return domain types (`lib/domain/types.ts`), mapping raw rows
(`lib/db/schema.ts`) at this boundary. The client is created once in `lib/db/client.ts`.

Rule rows are **assembled into their activity** here — a caller never receives an `Activity`
without its Temporal Placement rule attached, and never has to remember to fetch a rule table
separately. That is what makes the rules model safe to consume upstream.

## Reads

```ts
// Everything needed to render the current day's timeline + sidebar in one round of queries.
// Activities arrive with their rules already attached (placement always; overlap when present).
getDayView(date: string): Promise<{
  activities: Activity[];            // strict + flexible, each with placement (+ overlap for hosts)
  transitions: Transition[];         // linked to those activities
  blocks: ScheduledBlock[];          // standalone (hostActivityId === null) and guest blocks
}>;

// Single activity with its rules attached, or null.
getActivityById(id: string): Promise<Activity | null>;

// Guest blocks placed over a host on a date — input to remaining-budget derivation.
getGuestBlocksForHost(hostActivityId: string, date: string): Promise<ScheduledBlock[]>;

// Every occupied interval on the timeline for a date: strict activity spans, transitions,
// and scheduled blocks. Input to the standalone-block overlap check (FR-016).
getOccupiedRanges(date: string): Promise<Array<{ startMin: number; endMin: number }>>;
```

`getDayView` is the single read the timeline route makes. `blocks` is one array because guest and
standalone blocks share a table and are distinguished by `hostActivityId` (research §3) — this is
also why sidebar progress needs no union across sources.

## Writes

```ts
// Atomic: activity + its required placement rule + 0..2 transitions + optional overlap rule
// and allowed-guest rows commit together or not at all.
insertActivityWithRules(input: {
  activity: Activity;                 // carries placement, and overlap when the activity is a host
  transitions: Transition[];          // 0..2
}): Promise<void>;

// Used for both standalone blocks (hostActivityId === null) and guest blocks (non-null).
insertScheduledBlock(block: ScheduledBlock): Promise<void>;
```

## Guarantees

- **Single connection point**: `lib/db/client.ts` exports the one libSQL client and `queries.ts`
  is its only importer.
- **Typed boundary**: no raw row and no `any` escapes this module; callers never see SQL.
- **Rules travel with their activity**: reads join the rule tables, so an `Activity` in memory
  always satisfies "exactly one Temporal Placement rule" (FR-013).
- **Atomic multi-row writes**: `insertActivityWithRules` uses a libSQL transaction/batch, so an
  activity without its placement rule, or a host without its allowed-guest rows, cannot exist —
  the category invariants hold at every observable moment.
- **No business rules here**: this layer persists and reads. Rule evaluation lives in
  `lib/domain/rules.ts` and runs in the Server Action *before* these writes are called; derived
  figures (remaining overlap budget, activity progress, union totals) are computed in
  `lib/domain/accounting.ts` from what these reads return — never stored, never computed in SQL.

## Migration contract

- Schema defined in `lib/db/migrations/0001_init.sql`, checked into the repo: `activity`,
  `temporal_placement_rule`, `overlap_rule`, `overlap_allowed_guest`, `transition`,
  `scheduled_block`.
- Applied via a `pnpm db:migrate` script that runs pending `.sql` files against the configured
  Turso DB. Never edit a live DB by hand (Constitution III / Development Workflow).
- Adding a rule category later (e.g. Recurrence) is an **additive** migration: a new table keyed on
  `activity_id`. No existing column changes meaning (research §7).
- Env: `TURSO_DATABASE_URL` (may be `file:local.db` for dev), `TURSO_AUTH_TOKEN` (blank for a local
  file DB).
