import { AddActivitySheet } from "@/components/forms/add-activity-sheet"
import { OneOffEventSheet } from "@/components/forms/one-off-event-sheet"
import { cn } from "@/lib/utils"

export function ActionBar() {
  return (
    <div
      className={cn(
        "fixed right-0 bottom-0 left-0 z-40 mx-auto max-w-md bg-gradient-to-t from-background via-background to-transparent p-4"
      )}
    >
      <div className="flex gap-2">
        <AddActivitySheet />
        <OneOffEventSheet />
      </div>
    </div>
  )
}
