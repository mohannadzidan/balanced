import { Calendar } from "lucide-react"
import { Badge } from "@/components/ui/badge"

export function OneTimeActivity() {
  return (
    <div className="shadow-whisper flex items-center justify-between rounded-[12px] border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Calendar className="h-4 w-4 text-foreground" />
        <span className="text-sm font-medium text-foreground">
          Doctor Appointment
        </span>
      </div>
      <Badge
        variant="destructive"
        className="px-1.5 py-0.5 font-mono text-[10px]"
      >
        ONE-TIME
      </Badge>
    </div>
  )
}
