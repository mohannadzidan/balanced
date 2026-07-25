import { ActivityCard } from "./activity-card"

export function PreTransition() {
  return (
    <ActivityCard
      className="bg-muted border-border p-3"
      icon={null}
      title="Morning Routine"
      subtitle="Transition to Office Work"
      badge={{ label: "PRE", variant: "outline" }}
    />
  )
}