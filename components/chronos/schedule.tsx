import { ActivityCard } from "./activity-card"
import { TimelineSlot } from "./timeline-slot"
import { getTodayTimelineActivities } from "@/lib/db/timeline-queries"
import { formatTimeOfDate, todayISO } from "@/lib/time"

export async function Schedule() {
  const activities = await getTodayTimelineActivities(todayISO())

  return (
    <main className="px-4 pt-6 space-y-4">
      <div className="flex justify-between items-center pb-2">
        <h2 className="font-mono uppercase text-xs text-muted-foreground tracking-normal">Schedule</h2>
        <span className="font-mono text-xs text-muted-foreground/80">Solver: Idle</span>
      </div>
      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing scheduled yet. Activities with a Window Rule allowed today will appear here.
        </p>
      ) : (
        activities.map((activity) => (
          <TimelineSlot key={activity.id} time={formatTimeOfDate(activity.startTime)}>
            <ActivityCard
              title={activity.title}
              subtitle={`${formatTimeOfDate(activity.startTime)} - ${formatTimeOfDate(activity.endTime)}`}
            />
          </TimelineSlot>
        ))
      )}
    </main>
  )
}
