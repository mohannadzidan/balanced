-- 0001_init: activity definitions, their typed rules, transitions, and blocks.
--
-- Each rule CATEGORY gets its own table primary-keyed by activity id, so the
-- spec's "an activity holds at most one rule per category" is a database
-- invariant rather than an application check (data-model.md, research §1).
--
-- Times are integer minutes from midnight (0-1439); dates are YYYY-MM-DD text.
-- Rule classification (Hard vs Soft) is derived in code, never stored.

PRAGMA foreign_keys = ON;

-- A reusable global definition. Note what is NOT here: no start/end columns
-- (those are the Temporal Placement rule) and no is_container flag (that is
-- the presence of an overlap_rule row).
CREATE TABLE IF NOT EXISTS activity (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  constraint_type  TEXT NOT NULL CHECK (constraint_type IN ('strict', 'flexible')),
  daily_target_min INTEGER,
  min_block_min    INTEGER,
  created_date     TEXT NOT NULL
);

-- Category: Temporal Placement. Exactly one row per activity (FR-013).
CREATE TABLE IF NOT EXISTS temporal_placement_rule (
  activity_id TEXT PRIMARY KEY REFERENCES activity (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('preferred', 'strict')),
  start_min   INTEGER NOT NULL,
  end_min     INTEGER NOT NULL,
  CHECK (end_min > start_min)
);

-- Category: Overlap. Present only on strict hosts; its presence is what makes
-- an activity a host (FR-019, FR-020).
CREATE TABLE IF NOT EXISTS overlap_rule (
  host_activity_id TEXT PRIMARY KEY REFERENCES activity (id) ON DELETE CASCADE,
  budget_min       INTEGER NOT NULL CHECK (budget_min >= 0)
);

-- The allowed-guest set. An empty set is a valid host configuration.
CREATE TABLE IF NOT EXISTS overlap_allowed_guest (
  host_activity_id  TEXT NOT NULL REFERENCES activity (id) ON DELETE CASCADE,
  guest_activity_id TEXT NOT NULL REFERENCES activity (id) ON DELETE CASCADE,
  PRIMARY KEY (host_activity_id, guest_activity_id),
  CHECK (guest_activity_id <> host_activity_id)
);

-- At most one pre and one post per parent. No adjacency enforcement: a gap
-- between a transition and its parent is allowed (data-model.md §4).
CREATE TABLE IF NOT EXISTS transition (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activity (id) ON DELETE CASCADE,
  position    TEXT NOT NULL CHECK (position IN ('pre', 'post')),
  name        TEXT NOT NULL,
  start_min   INTEGER NOT NULL,
  end_min     INTEGER NOT NULL,
  CHECK (end_min > start_min),
  UNIQUE (activity_id, position)
);

-- A manually placed occurrence of a flexible activity. A non-null
-- host_activity_id makes the row a guest block overlapping that host
-- (research §3) -- one table, not two.
CREATE TABLE IF NOT EXISTS scheduled_block (
  id               TEXT PRIMARY KEY,
  activity_id      TEXT NOT NULL REFERENCES activity (id) ON DELETE CASCADE,
  date             TEXT NOT NULL,
  start_min        INTEGER NOT NULL,
  end_min          INTEGER NOT NULL,
  host_activity_id TEXT REFERENCES activity (id) ON DELETE CASCADE,
  CHECK (end_min > start_min)
);

-- Enough for the per-day timeline read, sidebar progress, and the
-- remaining-overlap-budget derivation.
CREATE INDEX IF NOT EXISTS idx_activity_created_date
  ON activity (created_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_block_date_activity
  ON scheduled_block (date, activity_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_block_date_host
  ON scheduled_block (date, host_activity_id);
CREATE INDEX IF NOT EXISTS idx_transition_activity
  ON transition (activity_id);
