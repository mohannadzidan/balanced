# Contract: Server Actions

Server Actions in `app/actions.ts` (`'use server'`) are the only mutation entry points. Each
receives `FormData` (via `useActionState`, so the signature is `(prevState, formData)`), parses it
with a Zod schema (`lib/domain/validation.ts`), evaluates the **pure rule functions**
(`lib/domain/rules.ts`), persists through `lib/db/queries.ts`, then calls `revalidatePath("/")`.

Verified against `node_modules/next/dist/docs/01-app/02-guides/forms.md` (the `'use server'` +
`useActionState(prevState, formData)` signature and error-return pattern) and
`.../04-functions/revalidatePath.md` (Server Functions update the viewed path's UI immediately —
FR-007).

## Shared result type

```ts
type ActionState =
  | { ok: true; warnings?: string[] }
  | { ok: false; formErrors: string[]; fieldErrors: Record<string, string[]> };
```

- `fieldErrors` — per-field messages from Zod `flatten()`.
- `formErrors` — cross-field / **Hard rule** messages (Strict Window violation, overlap, host
  bounds, budget, disallowed guest).
- `warnings` — **Soft rule** messages on an otherwise successful save. This is the FR-017 path:
  the block *is* persisted and `ok: true`, but the user is told the preference was violated. An
  action MUST NOT return `ok: false` for a Soft violation, and MUST NOT return `ok: true` with a
  silent one.

## How rule classification drives the response

Every rule check returns a verdict rather than a boolean (research §5):

```ts
type RuleVerdict =
  | { ok: true }
  | { ok: false; classification: "hard" | "soft"; message: string };
```

| Classification | Persisted? | Response |
|----------------|-----------|----------|
| **Hard** (Strict Window, End>Start, overlap, host bounds, budget, allowed-guest set) | **No** — nothing written | `{ ok: false, formErrors: [message] }` |
| **Soft** (Preferred Window) | **Yes** | `{ ok: true, warnings: [message] }` |

The timeline additionally **derives** the Soft-violation flag when rendering (a block outside its
activity's Preferred Window is badged), so the warning outlives the single action response
(FR-017, SC-004).

---

## 1. `createActivity(prev, formData): Promise<ActionState>`

Covers FR-003–FR-006, FR-009–FR-010, FR-012–FR-013, FR-019–FR-020.

**Input fields (FormData)**

- `name` (string, required)
- `constraintType` (`"strict"` | `"flexible"`, required)
- **Temporal Placement (required, exactly one — FR-013)**:
  - `placementKind` (`"preferred"` | `"strict"`)
  - `placementStartMin`, `placementEndMin` (0–1439 ints)

  For a Strict activity these *are* its fixed start/end times and `placementKind` MUST be
  `"strict"`. For a Flexible activity they are the window its blocks float inside.
- Flexible-only: `dailyTargetMin`, `minBlockMin` (positive ints)
- Overlap Rule (strict only, optional): `overlapEnabled` (bool), `overlapBudgetMin` (int ≥ 0),
  `allowedGuestIds` (0..n activity IDs)
- Transitions (optional): `preName`/`preStartMin`/`preEndMin`,
  `postName`/`postStartMin`/`postEndMin`

**Validation / rules** (all **Hard** — any failure rejects the whole save)

1. **Zod**, discriminated on `constraintType`: required fields present and typed, ints in range.
   The schema models Temporal Placement as a single discriminated object, so submitting *both* a
   preferred and a strict window is unrepresentable at the boundary (FR-013).
2. `placementEndMin > placementStartMin` (FR-005, Edge Case).
3. Strict ⇒ `placementKind === "strict"`; flexible-only fields absent.
4. Flexible ⇒ `dailyTargetMin > 0` and `minBlockMin > 0`; Overlap fields absent (a Flexible
   activity cannot be a host — spec Assumption).
5. Each supplied transition ⇒ `endMin > startMin` (Edge Case); at most one pre and one post.
6. Overlap Rule, when `overlapEnabled`:
   - allowed only when `constraintType === "strict"`;
   - `overlapBudgetMin >= 0`;
   - every `allowedGuestIds` entry MUST reference an existing **flexible** activity;
   - the activity being created MUST NOT appear in the set — no self-overlap (Edge Case). The new
     activity has no ID yet so this is naturally satisfied; reject any self-reference anyway;
   - an **empty** guest set is accepted (Edge Case): the host saves with a budget and no guests.

**Effect**: insert the Activity, its required `temporal_placement_rule` row, 0–2 Transitions, and
— if enabled — `overlap_rule` plus `overlap_allowed_guest` rows. **One atomic unit**: if any
insert fails, none persist. An activity can never exist without its Temporal Placement rule.

**Returns**: `{ ok: true }` and revalidates `/` (FR-007), or an error state.

---

## 2. `scheduleFlexibleBlock(prev, formData): Promise<ActionState>`

Covers FR-015–FR-018. Places a **standalone** block (`host_activity_id = NULL`).

**Input fields**: `activityId` (a flexible activity), `startMin` (int).

**Validation / rules**

1. Zod: `activityId` non-empty, `startMin` in 0–1439.
2. Load the activity; it MUST be flexible. Compute `endMin = startMin + minBlockMin` (FR-015).
3. **Temporal Placement check** against the activity's rule:
   - `kind = "strict"` and `[startMin, endMin]` outside the window ⇒ **Hard** ⇒ reject (FR-016).
   - `kind = "preferred"` and outside the window ⇒ **Soft** ⇒ persist and warn (FR-017).
4. **Overlap check** (**Hard**, FR-016): MUST NOT intersect any existing block on the timeline for
   the date — strict activity spans, transitions, and other scheduled blocks (including guest
   blocks). Intersection = ranges overlap with positive length.

**Effect**: insert one `scheduled_block` with `host_activity_id = NULL`. No write on a Hard
failure.

**Returns**: `{ ok: true }` (with `warnings` on a Soft violation) and revalidates `/`, so the
timeline and the sidebar progress both update in the same interaction (FR-018, SC-005); or an
error state describing the Strict-Window or overlap rejection.

---

## 3. `scheduleGuestBlock(prev, formData): Promise<ActionState>`

Covers FR-022–FR-024. Places a **guest block** overlapping a host (non-null `host_activity_id`).

**Input fields**: `hostActivityId`, `guestActivityId`, `startMin` (int).

**Validation / rules** — all **Hard**; any failure rejects without persisting (FR-023)

1. Zod: both IDs non-empty, `startMin` in 0–1439.
2. Load the host (must be strict and have an `overlap_rule`) with its allowed-guest set and
   Temporal Placement rule; load the guest (must be flexible). Compute
   `endMin = startMin + guest.minBlockMin`.
3. `guestActivityId` MUST be in the host's allowed-guest set.
4. `[startMin, endMin]` MUST fall entirely within the host's window bounds — reject if the guest's
   minimum block would extend past the host's end (Edge Case).
5. `endMin − startMin` MUST NOT exceed the host's **remaining** budget, derived as
   `budget_min − Σ` existing guest-block durations for this host/date (never stored).
6. The general overlap check of action 2 does **not** apply to the host's own span — that is the
   sanctioned-overlap exemption. The guest may intersect its host and nothing else.

**Effect**: insert one `scheduled_block` with `host_activity_id` set.

**Accounting guarantee (FR-026, SC-007)**: the write adds **no** minutes to the host. The host's
logged duration remains its own span, the guest's minutes count toward the *guest's* daily
progress, and the day's total logged time is the union measure of intervals — so a 30-minute guest
inside an 8-hour host yields 8h of covered clock, never 8h30m.

**Returns**: `{ ok: true }` and revalidates `/` — the timeline shows the guest layered over the
host (FR-025) and the detail panel shows the reduced remaining budget (FR-024) — or an error state.

---

## Error-handling contract

- Rule and validation failures are **returned**, never thrown — the dialog renders them from
  `state`.
- Unexpected/infrastructure errors (DB unreachable) throw and surface via the route's error
  boundary; they are not part of the normal `ActionState` shape.
- No action ever performs a partial write on a validation failure.
- Every action ends with `revalidatePath("/")` on success only.
