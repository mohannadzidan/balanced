/** Config payloads stored in `ruleTable.config` / `timelineRuleTable.config`, keyed by `ruleType`. */

export type RuleType = "window" | "sequence" | "overlap"

export type WindowRuleConfig = {
  kind: "strict" | "flexible"
  startMin: number
  endMin: number
}

export type SequenceRuleConfig = {
  preActivityId: string | null
  postActivityId: string | null
}

export type OverlapRuleConfig = {
  budgetMin: number
}

export type ActivityRules = {
  window: WindowRuleConfig | null
  sequence: SequenceRuleConfig | null
  overlap: (OverlapRuleConfig & { guestActivityIds: string[] }) | null
}
