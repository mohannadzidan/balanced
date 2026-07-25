import { ActivityCard } from "./activity-card"
import { EditActivityRulesSheet } from "@/components/forms/edit-activity-rules-sheet"
import { listActivities } from "@/lib/db/activity-queries"
import { getActivityRules, listOtherActivities } from "@/lib/db/rule-queries"
import { weekdayLabel, type Weekday } from "@/lib/weekdays"

export async function ActivityTemplates() {
  const activities = await listActivities()

  if (activities.length === 0) {
    return null
  }

  const rows = await Promise.all(
    activities.map(async (activity) => ({
      activity,
      rules: await getActivityRules(activity.id),
      otherActivities: await listOtherActivities(activity.id),
    }))
  )

  return (
    <section className="px-4 pt-6 space-y-2">
      <h2 className="font-mono uppercase text-xs text-muted-foreground tracking-normal pb-1">
        Activities
      </h2>
      <div className="space-y-2">
        {rows.map(({ activity, rules, otherActivities }) => (
          <div key={activity.id} className="flex items-center gap-2">
            <ActivityCard
              className="flex-1"
              title={activity.name}
              subtitle={
                activity.allowedDays.length > 0
                  ? activity.allowedDays.map((day) => weekdayLabel(day as Weekday)).join(", ")
                  : "No days selected"
              }
              badge={
                activity.isTransitionOnly
                  ? { label: "TRANSITION ONLY", variant: "secondary" }
                  : { label: "TEMPLATE", variant: "outline" }
              }
            />
            <EditActivityRulesSheet
              activityId={activity.id}
              activityName={activity.name}
              initialAllowedDays={activity.allowedDays as Weekday[]}
              initialIsTransitionOnly={activity.isTransitionOnly}
              initialRules={rules}
              otherActivities={otherActivities}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
