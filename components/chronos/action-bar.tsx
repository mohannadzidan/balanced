import { AddActivitySheet } from "@/components/forms/add-activity-sheet"
import { OneOffEventSheet } from "@/components/forms/one-off-event-sheet"
import { cn } from "@/lib/utils"

export function ActionBar() {
  return (
    <div className={cn(
      "fixed bottom-0 left-0 right-0 max-w-md mx-auto p-4 bg-gradient-to-t from-background via-background to-transparent z-40"
    )}>
      <div className="flex gap-2">
        <AddActivitySheet />
        <OneOffEventSheet />
      </div>
    </div>
  )
}