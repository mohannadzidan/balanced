import { activityProgressMin } from "@/lib/domain/accounting"
import type { FlexibleActivity, ScheduledBlock } from "@/lib/domain/types"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export type FlexibleSidebarProps = {
  activities: FlexibleActivity[]
  blocks: ScheduledBlock[]
}

/** Minutes as a compact hour label — "4h", "1.5h" — never rounded away. */
function formatHours(minutes: number): string {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

/**
 * "Flexible Activities" progress list (FR-014, SC-003): each Flexible
 * activity against its daily target as "Xh / Yh". Over-target progress is
 * shown as-is, never capped (spec Edge Case).
 */
export function FlexibleSidebar({ activities, blocks }: FlexibleSidebarProps) {
  if (activities.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        Flexible Activities
      </h2>
      {activities.map((activity) => {
        const progressMin = activityProgressMin(activity.id, blocks)
        return (
          <Card key={activity.id} size="sm">
            <CardHeader>
              <CardTitle>{activity.name}</CardTitle>
              <CardDescription>
                {formatHours(progressMin)} / {formatHours(activity.dailyTargetMin)}
              </CardDescription>
            </CardHeader>
          </Card>
        )
      })}
    </div>
  )
}
