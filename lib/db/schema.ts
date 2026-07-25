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

// ---------------

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

// ==========================================
// 1. Template Layer (Global Definitions)
// ==========================================

export const activityTable = sqliteTable("activity", {
  id: text("id").primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  allowedDays: text("allowed_days", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(strftime('%s', 'now'))`),
});

export const trackingLedgerTable = sqliteTable("tracking_ledger", {
  activityId: text("activity_id").primaryKey().notNull().references(() => activityTable.id, { onDelete: "cascade" }),
  rollingTargetMinutes: integer("rolling_target_minutes").notNull().default(0),
  rollingAchievedMinutes: integer("rolling_achieved_minutes").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(strftime('%s', 'now'))`),
});

export const ruleTable = sqliteTable("rule", {
  id: text("id").primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  activityId: text("activity_id").notNull().references(() => activityTable.id, { onDelete: "cascade" }),
  ruleType: text("rule_type").notNull(),
  config: text("config", { mode: "json" }).notNull(),
}, (table) => ({
  activityRuleTypeIdx: uniqueIndex("activity_rule_type_idx").on(table.activityId, table.ruleType),
}));

export const overlapAllowedGuestTable = sqliteTable("overlap_allowed_guest", {
  id: text("id").primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  ruleId: text("rule_id").notNull().references(() => ruleTable.id, { onDelete: "cascade" }),
  guestActivityId: text("guest_activity_id").notNull().references(() => activityTable.id, { onDelete: "cascade" }),
});

// ==========================================
// 2. Execution Layer (Timeline Instances)
// ==========================================

export const timelineTable = sqliteTable("timeline", {
  id: text("id").primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  date: text("date").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(strftime('%s', 'now'))`),
}, (table) => [uniqueIndex("date_idx").on(table.date)]);

export const timelineActivityTable = sqliteTable("timeline_activity", {
  id: text("id").primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  timelineId: text("timeline_id").notNull().references(() => timelineTable.id, { onDelete: "cascade" }),
  sourceActivityId: text("source_activity_id").references(() => activityTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  startTime: integer("start_time", { mode: "timestamp" }).notNull(),
  endTime: integer("end_time", { mode: "timestamp" }).notNull(),
  actualStartTime: integer("actual_start_time", { mode: "timestamp" }),
  actualEndTime: integer("actual_end_time", { mode: "timestamp" }),
  status: text("status").notNull().default("upcoming"),
  isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
});

export const timelineRuleTable = sqliteTable("timeline_rule", {
  id: text("id").primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  timelineActivityId: text("timeline_activity_id").notNull().references(() => timelineActivityTable.id, { onDelete: "cascade" }),
  ruleType: text("rule_type").notNull(),
  config: text("config", { mode: "json" }).notNull(),
});

export const timelineOverlapGuestTable = sqliteTable("timeline_overlap_guest", {
  id: text("id").primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  timelineRuleId: text("timeline_rule_id").notNull().references(() => timelineRuleTable.id, { onDelete: "cascade" }),
  timelineGuestActivityId: text("timeline_guest_activity_id").notNull().references(() => timelineActivityTable.id, { onDelete: "cascade" }),
});
