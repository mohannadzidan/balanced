import { TimelineBlock } from "@/components/timeline/timeline-block"
import type {
  Activity,
  ScheduledBlock,
  StrictActivity,
  Transition,
} from "@/lib/domain/types"

export type TimelineProps = {
  activities: Activity[]
  transitions: Transition[]
  blocks: ScheduledBlock[]
}

type RenderedBlock = {
  id: string
  label: string
  startMin: number
  endMin: number
}

/**
 * The current day's timeline as a single ordered list of blocks
 * (research §12). Only Strict activities contribute a block so far —
 * transitions (US2) and Flexible/guest blocks (US3/US4) merge into this same
 * ordering as later stories land.
 */
export function Timeline({ activities }: TimelineProps) {
  const blocks: RenderedBlock[] = activities
    .filter((activity): activity is StrictActivity => activity.constraintType === "strict")
    .map((activity) => ({
      id: activity.id,
      label: activity.name,
      startMin: activity.placement.startMin,
      endMin: activity.placement.endMin,
    }))
    .sort((a, b) => a.startMin - b.startMin)

  if (blocks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No activities recorded for today yet.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block) => (
        <TimelineBlock
          key={block.id}
          label={block.label}
          startMin={block.startMin}
          endMin={block.endMin}
          variant="strict"
        />
      ))}
    </div>
  )
}
