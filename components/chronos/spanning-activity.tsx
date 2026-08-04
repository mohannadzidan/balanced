import { Bed } from "lucide-react"
import { ActivityCard } from "./activity-card"

export function SpanningActivity() {
  return (
    <ActivityCard
      icon={<Bed className="h-3.5 w-3.5 text-foreground" />}
      title="Sleep"
      badge={{
        label: (
          <span className="flex items-center gap-1">
            <Bed className="h-2.5 w-2.5" />
            SPANNING
          </span>
        ),
        variant: "outline",
        className: "bg-muted border-border flex items-center gap-1",
      }}
      className="shadow-whisper"
    />
  )
}
