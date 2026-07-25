import { ActivityCard } from "./activity-card"
import { TimelineSlot } from "./timeline-slot"
import { ActiveActivityCard } from "@/components/forms/active-activity-card"
import { AddGuestSheet } from "@/components/forms/add-guest-sheet"
import { GuestActivityActions } from "@/components/forms/guest-activity-actions"
import { TimelineActivityActions } from "@/components/forms/timeline-activity-actions"
import { listActivitiesByIds } from "@/lib/db/activity-queries"
import { getGuestLinks, getOverlapBudgetForHost } from "@/lib/db/overlap-queries"
import { getActivityRules } from "@/lib/db/rule-queries"
import { getOrCreateTimeline, getTodayTimelineActivities } from "@/lib/db/timeline-queries"
import { formatTimeOfDate, todayISO } from "@/lib/time"

type GuestOption = { hostTimelineActivityId: string; remainingMin: number; guestOptions: { id: string; name: string }[] }

async function getGuestAddOption(activity: {
  id: string
  sourceActivityId: string | null
}): Promise<GuestOption | null> {
  if (!activity.sourceActivityId) return null
  const budget = await getOverlapBudgetForHost(activity.id)
  if (!budget || budget.remainingMin <= 0) return null

  const templateRules = await getActivityRules(activity.sourceActivityId)
  const guestActivityIds = templateRules.overlap?.guestActivityIds ?? []
  if (guestActivityIds.length === 0) return null

  const guestOptions = await listActivitiesByIds(guestActivityIds)
  if (guestOptions.length === 0) return null

  return { hostTimelineActivityId: activity.id, remainingMin: budget.remainingMin, guestOptions }
}

export async function Schedule() {
  const dateISO = todayISO()
  const now = new Date()
  const [activities, timeline] = await Promise.all([
    getTodayTimelineActivities(dateISO),
    getOrCreateTimeline(dateISO),
  ])
  const { guestIdToHostId, hostIdToGuestIds } = await getGuestLinks(timeline.id)

  const byId = new Map(activities.map((activity) => [activity.id, activity]))
  const topLevel = activities.filter((activity) => !guestIdToHostId.has(activity.id))
  const guestAddOptions = await Promise.all(topLevel.map((activity) => getGuestAddOption(activity)))
  const guestAddOptionById = new Map(
    topLevel.map((activity, index) => [activity.id, guestAddOptions[index]] as const)
  )

  return (
    <main className="px-4 pt-6 space-y-4">
      <div className="flex justify-between items-center pb-2">
        <h2 className="font-mono uppercase text-xs text-muted-foreground tracking-normal">Schedule</h2>
        <span className="font-mono text-xs text-muted-foreground/80">Solver: Idle</span>
      </div>
      {topLevel.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing scheduled yet. Activities with a Window Rule allowed today will appear here.
        </p>
      ) : (
        topLevel.map((activity) => {
          const guestIds = hostIdToGuestIds.get(activity.id) ?? []
          const guestAddOption = guestAddOptionById.get(activity.id) ?? null
          const isActive = activity.status !== "completed" && activity.startTime <= now

          const nested = (
            <>
              {guestIds.map((guestId) => {
                const guest = byId.get(guestId)
                if (!guest) return null
                return (
                  <div key={guest.id} className="mt-2 border-l-2 border-border pl-3">
                    <ActivityCard
                      title={guest.title}
                      subtitle={`${formatTimeOfDate(guest.startTime)} - ${formatTimeOfDate(guest.endTime)}`}
                      badge={{ label: "GUEST", variant: "secondary" }}
                      className="shadow-none"
                    >
                      <GuestActivityActions
                        timelineActivityId={guest.id}
                        status={guest.status}
                        hasStarted={guest.startTime <= now}
                      />
                    </ActivityCard>
                  </div>
                )
              })}
              {guestAddOption && (
                <div className="mt-2">
                  <AddGuestSheet
                    hostTimelineActivityId={guestAddOption.hostTimelineActivityId}
                    hostTitle={activity.title}
                    remainingMin={guestAddOption.remainingMin}
                    guestOptions={guestAddOption.guestOptions}
                  />
                </div>
              )}
            </>
          )

          return (
            <TimelineSlot key={activity.id} time={formatTimeOfDate(activity.startTime)}>
              {isActive ? (
                <ActiveActivityCard
                  timelineActivityId={activity.id}
                  title={activity.title}
                  subtitle={`${formatTimeOfDate(activity.startTime)} - ${formatTimeOfDate(activity.endTime)}`}
                  endTime={activity.endTime}
                >
                  {nested}
                </ActiveActivityCard>
              ) : (
                <ActivityCard
                  title={activity.title}
                  subtitle={`${formatTimeOfDate(activity.startTime)} - ${formatTimeOfDate(activity.endTime)}`}
                  badge={
                    activity.warningMessage
                      ? { label: "AT RISK", variant: "destructive" }
                      : undefined
                  }
                >
                  {activity.warningMessage && (
                    <p className="mt-1 text-xs text-destructive">{activity.warningMessage}</p>
                  )}
                  <TimelineActivityActions
                    timelineActivityId={activity.id}
                    status={activity.status}
                    isPinned={activity.isPinned}
                  />
                  {nested}
                </ActivityCard>
              )}
            </TimelineSlot>
          )
        })
      )}
    </main>
  )
}
