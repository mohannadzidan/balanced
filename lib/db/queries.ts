/**
 * The data-access layer (Constitution III): the only module permitted to
 * issue Turso/libSQL queries. Server Actions and Server Components import
 * typed functions from here; nothing else opens a connection or writes SQL.
 *
 * Rule rows are assembled into their activity here — a caller never receives
 * an `Activity` without its Temporal Placement rule attached
 * (contracts/data-access.md).
 */

import type { InStatement } from "@libsql/client"

import { db } from "@/lib/db/client"
import type {
  ActivityRow,
  ScheduledBlockRow,
  TemporalPlacementRuleRow,
  TransitionRow,
} from "@/lib/db/schema"
import type {
  Activity,
  ScheduledBlock,
  TemporalPlacementRule,
  Transition,
} from "@/lib/domain/types"

function toTemporalPlacementRule(
  row: TemporalPlacementRuleRow
): TemporalPlacementRule {
  return row.kind === "strict"
    ? { kind: "strict", startMin: row.start_min, endMin: row.end_min }
    : { kind: "preferred", startMin: row.start_min, endMin: row.end_min }
}

function toTransition(row: TransitionRow): Transition {
  return {
    id: row.id,
    activityId: row.activity_id,
    position: row.position,
    name: row.name,
    startMin: row.start_min,
    endMin: row.end_min,
  }
}

function toScheduledBlock(row: ScheduledBlockRow): ScheduledBlock {
  return {
    id: row.id,
    activityId: row.activity_id,
    date: row.date,
    startMin: row.start_min,
    endMin: row.end_min,
    hostActivityId: row.host_activity_id,
  }
}

function toActivity(
  activityRow: ActivityRow,
  placementRow: TemporalPlacementRuleRow
): Activity {
  const placement = toTemporalPlacementRule(placementRow)

  if (activityRow.constraint_type === "strict") {
    if (placement.kind !== "strict") {
      throw new Error(
        `strict activity ${activityRow.id} has a non-strict placement rule`
      )
    }
    return {
      id: activityRow.id,
      name: activityRow.name,
      constraintType: "strict",
      placement,
      overlap: null,
      createdDate: activityRow.created_date,
    }
  }

  if (activityRow.daily_target_min === null || activityRow.min_block_min === null) {
    throw new Error(
      `flexible activity ${activityRow.id} is missing its daily target or minimum block`
    )
  }

  return {
    id: activityRow.id,
    name: activityRow.name,
    constraintType: "flexible",
    dailyTargetMin: activityRow.daily_target_min,
    minBlockMin: activityRow.min_block_min,
    placement,
    createdDate: activityRow.created_date,
  }
}

/**
 * Everything needed to render the current day's timeline + sidebar in one
 * round of queries. Activities arrive with their Temporal Placement rule
 * already attached (FR-013), `transitions` with the day's activities they
 * belong to, and `blocks` with both standalone (`hostActivityId === null`)
 * and guest blocks scheduled for the date.
 */
export async function getDayView(date: string): Promise<{
  activities: Activity[]
  transitions: Transition[]
  blocks: ScheduledBlock[]
}> {
  const [activityResult, transitionResult, blockResult] = await Promise.all([
    db.execute({
      sql: `SELECT
              a.id AS id,
              a.name AS name,
              a.constraint_type AS constraint_type,
              a.daily_target_min AS daily_target_min,
              a.min_block_min AS min_block_min,
              a.created_date AS created_date,
              t.kind AS placement_kind,
              t.start_min AS placement_start_min,
              t.end_min AS placement_end_min
            FROM activity a
            JOIN temporal_placement_rule t ON t.activity_id = a.id
            WHERE a.created_date = ?`,
      args: [date],
    }),
    db.execute({
      sql: `SELECT
              tr.id AS id,
              tr.activity_id AS activity_id,
              tr.position AS position,
              tr.name AS name,
              tr.start_min AS start_min,
              tr.end_min AS end_min
            FROM transition tr
            JOIN activity a ON a.id = tr.activity_id
            WHERE a.created_date = ?`,
      args: [date],
    }),
    db.execute({
      sql: `SELECT
              id AS id,
              activity_id AS activity_id,
              date AS date,
              start_min AS start_min,
              end_min AS end_min,
              host_activity_id AS host_activity_id
            FROM scheduled_block
            WHERE date = ?`,
      args: [date],
    }),
  ])

  const activities = activityResult.rows.map((row) => {
    const activityRow: ActivityRow = {
      id: String(row.id),
      name: String(row.name),
      constraint_type: row.constraint_type as "strict" | "flexible",
      daily_target_min:
        row.daily_target_min === null ? null : Number(row.daily_target_min),
      min_block_min:
        row.min_block_min === null ? null : Number(row.min_block_min),
      created_date: String(row.created_date),
    }
    const placementRow: TemporalPlacementRuleRow = {
      activity_id: activityRow.id,
      kind: row.placement_kind as "preferred" | "strict",
      start_min: Number(row.placement_start_min),
      end_min: Number(row.placement_end_min),
    }
    return toActivity(activityRow, placementRow)
  })

  const transitions = transitionResult.rows.map((row) => {
    const transitionRow: TransitionRow = {
      id: String(row.id),
      activity_id: String(row.activity_id),
      position: row.position as "pre" | "post",
      name: String(row.name),
      start_min: Number(row.start_min),
      end_min: Number(row.end_min),
    }
    return toTransition(transitionRow)
  })

  const blocks = blockResult.rows.map((row) => {
    const blockRow: ScheduledBlockRow = {
      id: String(row.id),
      activity_id: String(row.activity_id),
      date: String(row.date),
      start_min: Number(row.start_min),
      end_min: Number(row.end_min),
      host_activity_id:
        row.host_activity_id === null ? null : String(row.host_activity_id),
    }
    return toScheduledBlock(blockRow)
  })

  return { activities, transitions, blocks }
}

/**
 * Every occupied interval on the timeline for a date — strict activity
 * spans, transitions, and scheduled blocks (both standalone and guest).
 * Input to the standalone-block overlap check (FR-016).
 */
export async function getOccupiedRanges(
  date: string
): Promise<Array<{ startMin: number; endMin: number }>> {
  const { activities, transitions, blocks } = await getDayView(date)

  const activityRanges = activities
    .filter((activity) => activity.constraintType === "strict")
    .map((activity) => ({
      startMin: activity.placement.startMin,
      endMin: activity.placement.endMin,
    }))

  const transitionRanges = transitions.map((transition) => ({
    startMin: transition.startMin,
    endMin: transition.endMin,
  }))

  const blockRanges = blocks.map((block) => ({
    startMin: block.startMin,
    endMin: block.endMin,
  }))

  return [...activityRanges, ...transitionRanges, ...blockRanges]
}

/**
 * Atomic: the activity row, its required Temporal Placement rule row, and
 * 0–2 Transition rows commit together or not at all — an activity without
 * its placement rule must be unrepresentable (contracts/data-access.md
 * "Atomic multi-row writes").
 */
export async function insertActivityWithRules(input: {
  activity: Activity
  transitions: Transition[]
}): Promise<void> {
  const { activity, transitions } = input

  const statements: InStatement[] = [
    {
      sql: `INSERT INTO activity
              (id, name, constraint_type, daily_target_min, min_block_min, created_date)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        activity.id,
        activity.name,
        activity.constraintType,
        activity.constraintType === "flexible" ? activity.dailyTargetMin : null,
        activity.constraintType === "flexible" ? activity.minBlockMin : null,
        activity.createdDate,
      ],
    },
    {
      sql: `INSERT INTO temporal_placement_rule (activity_id, kind, start_min, end_min)
            VALUES (?, ?, ?, ?)`,
      args: [
        activity.id,
        activity.placement.kind,
        activity.placement.startMin,
        activity.placement.endMin,
      ],
    },
  ]

  for (const transition of transitions) {
    statements.push({
      sql: `INSERT INTO transition (id, activity_id, position, name, start_min, end_min)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        transition.id,
        transition.activityId,
        transition.position,
        transition.name,
        transition.startMin,
        transition.endMin,
      ],
    })
  }

  await db.batch(statements, "write")
}

/**
 * Insert one `scheduled_block` row. Used for both standalone blocks
 * (`hostActivityId === null`) and guest blocks (non-null).
 */
export async function insertScheduledBlock(block: ScheduledBlock): Promise<void> {
  await db.execute({
    sql: `INSERT INTO scheduled_block
            (id, activity_id, date, start_min, end_min, host_activity_id)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      block.id,
      block.activityId,
      block.date,
      block.startMin,
      block.endMin,
      block.hostActivityId,
    ],
  })
}
