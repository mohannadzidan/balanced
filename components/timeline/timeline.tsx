import {
  TimelineBlock,
  type TimelineBlockVariant,
} from "@/components/timeline/timeline-block"
import { evaluatePlacement } from "@/lib/domain/rules"
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
  variant: TimelineBlockVariant
  softViolation?: boolean
}

/**
 * The current day's timeline as a single ordered list of blocks
 * (research §12). Strict activities, their pre/post transitions, and
 * standalone Flexible blocks contribute blocks so far — guest-overlap blocks
 * (US4) merge into this same ordering as that story lands.
 */
export function Timeline({ activities, transitions, blocks }: TimelineProps) {
  const activityById = new Map(activities.map((activity) => [activity.id, activity]))

  const activityBlocks: RenderedBlock[] = activities
    .filter((activity): activity is StrictActivity => activity.constraintType === "strict")
    .map((activity) => ({
      id: activity.id,
      label: activity.name,
      startMin: activity.placement.startMin,
      endMin: activity.placement.endMin,
      variant: "strict" as const,
    }))

  const transitionBlocks: RenderedBlock[] = transitions.map((transition) => ({
    id: transition.id,
    label: transition.name,
    startMin: transition.startMin,
    endMin: transition.endMin,
    variant: "transition" as const,
  }))

  const flexibleBlocks: RenderedBlock[] = blocks
    .filter((block) => block.hostActivityId === null)
    .flatMap((block) => {
      const activity = activityById.get(block.activityId)
      if (!activity || activity.constraintType !== "flexible") return []

      const verdict = evaluatePlacement(activity.placement, block.startMin, block.endMin)
      return [
        {
          id: block.id,
          label: activity.name,
          startMin: block.startMin,
          endMin: block.endMin,
          variant: "flexible" as const,
          softViolation: !verdict.ok && verdict.classification === "soft",
        },
      ]
    })

  const renderedBlocks = [...activityBlocks, ...transitionBlocks, ...flexibleBlocks].sort(
    (a, b) => a.startMin - b.startMin
  )

  if (renderedBlocks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No activities recorded for today yet.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {renderedBlocks.map((block) => (
        <TimelineBlock
          key={block.id}
          label={block.label}
          startMin={block.startMin}
          endMin={block.endMin}
          variant={block.variant}
          softViolation={block.softViolation}
        />
      ))}
    </div>
  )
}
