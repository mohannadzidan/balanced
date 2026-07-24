import { formatHHMM } from "@/lib/time"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

/**
 * Visual treatment for a timeline block.
 *
 * Only `"strict"` exists for now (User Story 1). Later user stories widen
 * this union with `"transition"`, `"flexible"`, and `"guest-overlap"` — this
 * component's `variant` prop is wired through in advance so those additions
 * are additive, not a rework.
 */
export type TimelineBlockVariant = "strict"

export type TimelineBlockProps = {
  label: string
  startMin: number
  endMin: number
  variant: TimelineBlockVariant
}

/** A single block on the daily timeline: a label and its `HH:MM–HH:MM` range. */
export function TimelineBlock({
  label,
  startMin,
  endMin,
  variant,
}: TimelineBlockProps) {
  return (
    <Card data-variant={variant}>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>
          {formatHHMM(startMin)}–{formatHHMM(endMin)}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}
