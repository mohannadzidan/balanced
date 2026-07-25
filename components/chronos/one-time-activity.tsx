import { Calendar } from "lucide-react"
import { Badge } from "@/components/ui/badge"

export function OneTimeActivity() {
  return (
    <div className="bg-card border border-border rounded-[12px] p-3 flex justify-between items-center shadow-whisper">
      <div className="flex items-center gap-2">
        <Calendar className="h-4 w-4 text-foreground" />
        <span className="text-foreground text-sm font-medium">Doctor Appointment</span>
      </div>
      <Badge variant="destructive" className="font-mono text-[10px] px-1.5 py-0.5">
        ONE-TIME
      </Badge>
    </div>
  )
}