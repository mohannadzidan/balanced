import { Calendar } from "lucide-react"
import { ActivityCard } from "./activity-card"

export function OneTimeActivity() {
  return (
    <ActivityCard
      icon={<Calendar className="h-3.5 w-3.5 text-foreground" />}
      title="Doctor Appointment"
      badge={{ 
        label: "ONE-TIME", 
        variant: "secondary",
        className: "bg-warning-soft border border-warning/30" 
      }}
      className="shadow-whisper"
    />
  )
}