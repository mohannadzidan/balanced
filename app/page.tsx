import { AddActivityDialog } from "@/components/forms/add-activity-dialog"
import { ScheduleFlexibleDialog } from "@/components/forms/schedule-flexible-dialog"
import { FlexibleSidebar } from "@/components/timeline/flexible-sidebar"
import { Timeline } from "@/components/timeline/timeline"
import { getDayView } from "@/lib/db/queries"
import { todayISO } from "@/lib/time"

export default async function Page() {
  const dayView = await getDayView(todayISO())
  const flexibleActivities = dayView.activities.filter(
    (activity) => activity.constraintType === "flexible"
  )

  return (
    <div className="flex min-h-svh flex-col gap-6 p-6 md:flex-row">
      <div className="flex flex-1 flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="font-heading text-lg font-medium">Today</h1>
          <div className="flex items-center gap-2">
            <ScheduleFlexibleDialog activities={flexibleActivities} />
            <AddActivityDialog />
          </div>
        </div>
        <Timeline
          activities={dayView.activities}
          transitions={dayView.transitions}
          blocks={dayView.blocks}
        />
      </div>
      <div className="w-full md:w-64">
        <FlexibleSidebar activities={flexibleActivities} blocks={dayView.blocks} />
      </div>
    </div>
  )
}
