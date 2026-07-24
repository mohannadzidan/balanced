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
 * `"strict"` and `"transition"` exist so far (User Story 1 and 2). Later
 * user stories widen this union with `"flexible"` and `"guest-overlap"` —
 * this component's `variant` prop is wired through in advance so those
 * additions are additive, not a rework.
 */
export type TimelineBlockVariant = "strict" | "transition"

export type TimelineBlockProps = {
  label: string
  startMin: number
  endMin: number
  variant: TimelineBlockVariant
}

/**
 * A single block on the daily timeline: a label and its `HH:MM–HH:MM` range.
 *
 * A `"transition"` block is smaller and carries a "Transition" badge so it
 * reads as distinct from its parent activity's own block without any
 * explanation (FR-011, SC-008).
 */
export function TimelineBlock({
  label,
  startMin,
  endMin,
  variant,
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
      </CardHeader>
    </Card>
  )
}
