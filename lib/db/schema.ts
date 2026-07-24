/**
 * Raw database row shapes — one type per table in
 * `lib/db/migrations/0001_init.sql`, mirroring what libSQL actually returns.
 *
 * These are SQLite-shaped, not domain-shaped: snake_case column names, `TEXT`
 * as `string`, `INTEGER` as `number`, nullable columns as `| null` (never
 * optional `?`, since libSQL returns the key with a `null` value). Dates are
 * `string` in `YYYY-MM-DD` form. SQLite has no boolean type, so a boolean
 * column would arrive as `number` (0/1) — this schema currently has none.
 *
 * Rows are mapped to the domain types in `lib/domain/types.ts` inside
 * `lib/db/queries.ts`. No raw row escapes that boundary: everything above the
 * data layer speaks the domain vocabulary only (Constitution III/IV).
 */

/** `activity` — the reusable global definition. */
export type ActivityRow = {
  id: string
  name: string
  constraint_type: "strict" | "flexible"
  daily_target_min: number | null
  min_block_min: number | null
  created_date: string
}

/** `temporal_placement_rule` — exactly one row per activity (FR-013). */
export type TemporalPlacementRuleRow = {
  activity_id: string
  kind: "preferred" | "strict"
  start_min: number
  end_min: number
}

/** `overlap_rule` — present only on hosts; its presence is what makes one. */
export type OverlapRuleRow = {
  host_activity_id: string
  budget_min: number
}

/** `overlap_allowed_guest` — one row per allowed guest; the set may be empty. */
export type OverlapAllowedGuestRow = {
  host_activity_id: string
  guest_activity_id: string
}

/** `transition` — at most one `pre` and one `post` per parent activity. */
export type TransitionRow = {
  id: string
  activity_id: string
  position: "pre" | "post"
  name: string
  start_min: number
  end_min: number
}

/**
 * `scheduled_block` — a placed occurrence of a flexible activity. A non-null
 * `host_activity_id` makes the row a guest block overlapping that host.
 */
export type ScheduledBlockRow = {
  id: string
  activity_id: string
  date: string
  start_min: number
  end_min: number
  host_activity_id: string | null
}
