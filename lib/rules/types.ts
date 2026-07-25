/** Config payloads stored in `ruleTable.config` / `timelineRuleTable.config`, keyed by `ruleType`. */

export type RuleType = "window" | "sequence" | "overlap" | "tracking"

/** A Strict window is a fixed placement — its own span is the block's length. */
export type StrictWindowRuleConfig = {
  kind: "strict"
  startMin: number
  endMin: number
}

/**
 * A Preferred (soft) window is bounds the solver may place `durationMin`
 * worth of the activity within — e.g. an 8h Sleep block floating anywhere
 * inside a 21:00–07:00 window, rather than occupying the window's full span.
 */
export type FlexibleWindowRuleConfig = {
  kind: "flexible"
  startMin: number
  endMin: number
  durationMin: number
}

export type WindowRuleConfig = StrictWindowRuleConfig | FlexibleWindowRuleConfig

export type SequenceRuleConfig = {
  preActivityId: string | null
  postActivityId: string | null
}

export type OverlapRuleConfig = {
  budgetMin: number
}

export type TrackingRuleConfig = {
  dailyTargetMin: number
  minBlockMinutes: number
  carryOverEnabled: boolean
  capMin: number | null
}

export type ActivityRules = {
  window: WindowRuleConfig | null
  sequence: SequenceRuleConfig | null
  overlap: (OverlapRuleConfig & { guestActivityIds: string[] }) | null
  tracking: TrackingRuleConfig | null
}
