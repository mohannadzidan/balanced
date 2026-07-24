import { formatHHMM } from "@/lib/time"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"

/**
 * Visual treatment for a timeline block.
 *
 * `"strict"`, `"transition"`, and `"flexible"` exist so far (User Stories 1–3).
 * A later user story widens this union with `"guest-overlap"` — this
 * component's `variant` prop is wired through in advance so that addition is
 * additive, not a rework.
 */
export type TimelineBlockVariant = "strict" | "transition" | "flexible"

export type TimelineBlockProps = {
  label: string
  startMin: number
  endMin: number
  variant: TimelineBlockVariant
  /**
   * Derived at render time, never stored (data-model.md "Classification"):
   * true when a `"flexible"` block falls outside its activity's Preferred
   * Window. Ignored for other variants.
   */
  softViolation?: boolean
}

/**
 * A single block on the daily timeline: a label and its `HH:MM–HH:MM` range.
 *
 * A `"transition"` block is smaller and carries a "Transition" badge so it
 * reads as distinct from its parent activity's own block without any
 * explanation (FR-011, SC-008). A `"flexible"` block flagged `softViolation`
 * carries a "Preference violation" badge — the Soft-rule warning outlives the
 * single action response that produced it (FR-017, SC-004).
 */
export function TimelineBlock({
  label,
  startMin,
  endMin,
  variant,
  softViolation = false,
}: TimelineBlockProps) {
  return (
    <Card data-variant={variant} size={variant === "transition" ? "sm" : "default"}>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>
          {formatHHMM(startMin)}–{formatHHMM(endMin)}
        </CardDescription>
        {variant === "transition" && (
          <CardAction>
            <Badge variant="outline">Transition</Badge>
          </CardAction>
        )}
        {variant === "flexible" && softViolation && (
          <CardAction>
            <Badge variant="outline">Preference violation</Badge>
          </CardAction>
        )}
      </CardHeader>
    </Card>
  )
}
