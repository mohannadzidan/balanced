import { AddActivityDialog } from "@/components/forms/add-activity-dialog"
import { Timeline } from "@/components/timeline/timeline"
import { getDayView } from "@/lib/db/queries"
import { todayISO } from "@/lib/time"

export default async function Page() {
  const dayView = await getDayView(todayISO())

  return (
    <div className="flex min-h-svh flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-lg font-medium">Today</h1>
        <AddActivityDialog />
      </div>
      <Timeline
        activities={dayView.activities}
        transitions={dayView.transitions}
        blocks={dayView.blocks}
      />
    </div>
  )
}
