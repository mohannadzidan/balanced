import { Calendar } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AddActivitySheet } from "@/components/forms/add-activity-sheet"
import { cn } from "@/lib/utils"

export function ActionBar() {
  return (
    <div className={cn(
      "fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-gradient-to-t from-background via-background to-transparent z-40"
    )}>
      <div className="flex gap-2">
        <AddActivitySheet />
        <Button variant="outline" className="flex-1 flex items-center justify-center gap-2 shadow-whisper">
          <Calendar className="h-4 w-4" />
          One-Time Event
        </Button>
      </div>
    </div>
  )
}