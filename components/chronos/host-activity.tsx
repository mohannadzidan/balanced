import { ActivityCard } from "./activity-card"
import { GuestActivity } from "./guest-activity"

export function HostActivity() {
  return (
    <ActivityCard
      icon={<span className="h-2 w-2 rounded-full bg-foreground" />}
      title="Office Work"
      subtitle="10:00 - 18:00 \u2022 Overlap Budget: 60m"
      badge={{ label: "HOST", variant: "outline" }}
    >
      <GuestActivity />
    </ActivityCard>
  )
}
