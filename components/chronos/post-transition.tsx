import { ActivityCard } from "./activity-card"

export function PostTransition() {
  return (
    <ActivityCard
      className="border-border bg-muted p-3"
      icon={null}
      title="Commute Home"
      subtitle="Transition from Office Work"
      badge={{ label: "POST", variant: "outline" }}
    />
  )
}
