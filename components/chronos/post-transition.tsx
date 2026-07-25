import { ActivityCard } from "./activity-card"

export function PostTransition() {
  return (
    <ActivityCard
      className="bg-muted border-border p-3"
      icon={null}
      title="Commute Home"
      subtitle="Transition from Office Work"
      badge={{ label: "POST", variant: "outline" }}
    />
  )
}