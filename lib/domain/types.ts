/**
 * Domain types for the daily timeline.
 *
 * An activity is a global definition; its constraints are typed *rules*, one
 * per category. Discriminated unions keep both the constraint type and the
 * rule variant compiler-checked, so adding a rule variant later becomes a
 * compile error at every `switch` rather than a silent fallthrough
 * (Constitution IV, data-model.md "Domain types").
 *
 * All time-of-day fields are minutes from midnight (0–1439) and all dates are
 * `YYYY-MM-DD` local calendar dates.
 */

/** Temporal Placement, Soft variant: blocks outside the window are flagged. */
export type PreferredWindow = {
  kind: "preferred"
  startMin: number
  endMin: number
}

/** Temporal Placement, Hard variant: blocks outside the window are rejected. */
export type StrictWindow = {
  kind: "strict"
  startMin: number
  endMin: number
}

/**
 * The Temporal Placement rule — exactly one per activity (FR-013).
 * `kind` also carries the classification: strict ⇒ Hard, preferred ⇒ Soft.
 */
export type TemporalPlacementRule = PreferredWindow | StrictWindow

/**
 * The system-wide Overlap Rule as instantiated on a host activity.
 * Its presence is what makes an activity a host (FR-019, FR-020).
 */
export type OverlapRule = {
  hostActivityId: string
  budgetMin: number
  allowedGuestIds: string[]
}

/** An activity at fixed times: its block fills the whole placement window. */
export type StrictActivity = {
  id: string
  name: string
  constraintType: "strict"
  placement: StrictWindow
  /** Non-null ⇒ this activity hosts overlapping guests. */
  overlap: OverlapRule | null
  createdDate: string
}

/**
 * An activity with a daily target: its blocks are `minBlockMin` long and
 * float inside the placement window.
 */
export type FlexibleActivity = {
  id: string
  name: string
  constraintType: "flexible"
  dailyTargetMin: number
  minBlockMin: number
  placement: TemporalPlacementRule
  createdDate: string
}

export type Activity = StrictActivity | FlexibleActivity

/** Where a transition sits relative to its parent activity. */
export type TransitionPosition = "pre" | "post"

/**
 * A named block attached to one activity — at most one `pre` and one `post`.
 * Adjacency to the parent is NOT enforced; a gap is allowed and the
 * transition renders at its own recorded times (data-model.md §4).
 */
export type Transition = {
  id: string
  activityId: string
  position: TransitionPosition
  name: string
  startMin: number
  endMin: number
}

/**
 * A manually placed occurrence of a Flexible activity on the day's timeline.
 * A non-null `hostActivityId` makes this a *guest block* overlapping that
 * host — the same shape, one table (research §3).
 */
export type ScheduledBlock = {
  id: string
  activityId: string
  date: string
  startMin: number
  endMin: number
  hostActivityId: string | null
}
