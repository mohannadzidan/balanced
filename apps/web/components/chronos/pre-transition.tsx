import { ActivityCard } from "./activity-card"

export function PreTransition() {
  return (
    <ActivityCard
      className="border-border bg-muted p-3"
      icon={null}
      title="Morning Routine"
      subtitle="Transition to Office Work"
      badge={{ label: "PRE", variant: "outline" }}
    />
  )
}
