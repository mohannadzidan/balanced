import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

// ==========================================
// 1. Template Layer (Global Definitions)
// ==========================================

export const activityTable = sqliteTable("activity", {
  id: text("id").primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  allowedDays: text("allowed_days", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** True for activities that only ever appear as a Sequence Rule's pre/post transition (e.g. Commute) — the generator never schedules them standalone. */
  isTransitionOnly: integer("is_transition_only", { mode: "boolean" }).notNull().default(false),
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
