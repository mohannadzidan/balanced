# Quickstart & Validation: Manual Activity Scheduling & Timeline

Runnable validation for the four user stories. Field shapes and rule details live in
[data-model.md](./data-model.md), [contracts/server-actions.md](./contracts/server-actions.md),
and [contracts/data-access.md](./contracts/data-access.md) — not repeated here.

## Prerequisites

- Node.js 20, pnpm
- A Turso DB or a local libSQL file. For local dev, set in `.env.local`:
  ```
  TURSO_DATABASE_URL=file:local.db
  TURSO_AUTH_TOKEN=
  ```

## Setup

```bash
pnpm install
pnpm dlx shadcn@latest add dialog select input label checkbox card badge   # button already present
pnpm db:migrate      # applies lib/db/migrations/0001_init.sql
pnpm dev             # http://localhost:3000
```

## Automated checks (fast feedback on the logic seam)

```bash
pnpm test            # vitest: lib/domain/rules, lib/domain/accounting, lib/time
pnpm lint            # eslint
pnpm typecheck       # tsc --noEmit (strict)
```

Expected coverage:

- `rules.test.ts` — End>Start rejection; Strict Window violation returns a **hard** verdict;
  Preferred Window violation returns a **soft** verdict; overlap detection; host bounds;
  allowed-guest membership; budget exhaustion.
- `accounting.test.ts` — the FR-026 guarantee: `unionMinutes` collapses an 8-hour host plus a
  30-minute guest to **480**, not 510; host logged duration is unchanged by guests; guest minutes
  count toward the *guest's* progress; over-target progress is reported, not capped.
- `time.test.ts` — `"HH:MM"` ⇄ minutes conversions and duration math.

---

## Story 1 — View timeline & record a Strict activity (P1)

1. Open `http://localhost:3000` with no data → timeline renders **empty** (FR-002, AS-1).
2. Click **Add Activity**. Enter `Morning Standup`, Constraint = `Strict`, Start `10:00`, End
   `10:30`. Save. (The start/end *is* the activity's Strict Window rule.)
3. **Expected**: returned to the timeline with no manual refresh, showing one block labeled
   "Morning Standup" spanning 10:00–10:30 (FR-007/FR-008, SC-001).
4. **Negative**: create an activity with End `10:00` equal to Start `10:00` → save **rejected**,
   nothing persisted (FR-005, AS-4).

## Story 2 — Pre/post transitions (P2)

1. Add Activity → check **Add Pre-Transition** (`Commute`, 08:00–10:00), main activity
   (`Office Work`, Strict, 10:00–18:00), **Add Post-Transition** (`Commute Home`, 18:00–19:30).
   Save.
2. **Expected**: three blocks render in chronological order — Commute, Office Work, Commute
   Home — each at its own recorded times (FR-011, SC-002).
3. **Partial**: create another activity with only a pre-transition → only the activity and its pre
   persist and render (AS-4).
4. **Gap tolerated**: a pre-transition ending before the activity starts renders at its own times;
   no adjacency is enforced (Edge Case).

## Story 3 — Flexible activity, Temporal Placement choice, manual block (P3)

1. Add Activity → Constraint = `Flexible`; Start/End are replaced by Daily Target, Minimum Block,
   and a **Temporal Placement** choice (FR-012, AS-1).
2. **Exclusivity**: confirm the form offers **either** a Preferred Window **or** a Strict Window —
   selecting one clears/disables the other; both can never be submitted (FR-013, AS-2).
3. Enter `Freelance`, target `4h`, min block `2h`, **Preferred Window** `18:00–23:00`. Save.
4. **Expected**: the "Flexible Activities" sidebar lists `Freelance — 0h / 4h` (FR-014, SC-003).
5. Click **Schedule Block**, start `19:00`, confirm. The system computes end `21:00`, checks it
   against the Preferred Window and for overlaps, and saves (FR-015).
6. **Expected**: timeline shows Freelance 19:00–21:00; sidebar updates to `2h / 4h` in the same
   interaction (FR-018, SC-005).
7. **Soft violation (must NOT be rejected)**: schedule a `Freelance` block at `08:00` — outside the
   Preferred Window. **Expected**: the block **is saved** and is **visibly flagged** as a
   preference violation on the timeline (FR-017, SC-004). A rejection here is a failure.
8. **Hard violation**: repeat with an activity whose placement is a **Strict Window** and a start
   outside it → **rejected**, not persisted (FR-016, SC-004).
9. **Overlap**: schedule a block whose computed span intersects an existing block → **rejected**
   (FR-016).
10. **Over target**: schedule enough blocks to exceed `4h` → allowed; sidebar shows the
    over-target figure, no cap (Edge Case).

## Story 4 — Overlap Rule: host + allowed guests (P4)

Precondition: a Flexible activity `Lunch` (min block 30m) exists.

1. Add Activity → `Fulltime Work`, Strict, 10:00–18:00, enable the **Overlap Rule**
   ("Is Container" / "Allow overlap"). Set **Interruptible Minutes** `60` and **Allowed
   Interrupters** = [`Lunch`]. Save. (The activity being created is excluded from its own guest
   list — Edge Case; FR-019.)
2. Open the host's detail panel → **Interruptible Capacity: 60 mins** (FR-021, AS-2).
3. **Schedule Inside**, start `13:00`, guest `Lunch`. The system checks the guest is allowed, that
   13:00–13:30 falls inside 10:00–18:00, and that 30 ≤ 60 remaining; saves (FR-022/FR-023).
4. **Expected** (FR-024/FR-025, SC-007):
   - the timeline shows `Lunch` **layered over** `Fulltime Work` at 13:00–13:30, visually distinct
     from the host's uncovered time;
   - the detail panel shows **30 mins remaining**;
   - `Fulltime Work` still reports its full **10:00–18:00** span — **8h**, not 8h30m;
   - the sidebar shows `Lunch` progress increased by 30m (guest minutes count for the guest).
5. **Negatives** (each **rejected**, nothing persisted — FR-023, SC-006):
   - a guest not in the allowed set;
   - start `17:45` with a 30m block → would extend past the host's 18:00 end (Edge Case);
   - a guest whose duration exceeds the remaining budget (e.g. after 60m is consumed).
6. **Empty guest set**: create a host with a budget and no allowed guests → saves; **Schedule
   Inside** offers nothing (Edge Case).
7. **No self-overlap**: the host never appears in its own allowed-guest list (Edge Case).

---

## Done / acceptance

- [ ] All four stories pass their positive flows with no manual refresh (SC-001).
- [ ] Exactly one Temporal Placement rule per activity is enforceable in the UI and rejected
      otherwise at the boundary (FR-013, SC-003).
- [ ] Hard violations (Strict Window, overlap, host bounds, budget, disallowed guest) are rejected
      before persistence; Soft violations (Preferred Window) are **saved and flagged**, never
      silently accepted and never rejected (SC-004, SC-006).
- [ ] A host with guests reports its own span as its logged duration, and the day's total logged
      time never double-counts overlapping minutes (FR-026, SC-007).
- [ ] Activities, transitions, and overlapping guest blocks are visually distinguishable (SC-008).
- [ ] The full Story-4 flow (create host → assign guest → schedule guest) is completable in under
      2 minutes by someone new to the feature (SC-009).
- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass.
