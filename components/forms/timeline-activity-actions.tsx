"use client"

import { useTransition } from "react"
import { Pin, PinOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { togglePinAction } from "@/lib/actions/execution"

/** Pin toggle only — Finish Early/Extend live on `ActiveActivityCard` once a block has actually started. */
export function TimelineActivityActions({
  timelineActivityId,
  status,
  isPinned,
}: {
  timelineActivityId: string
  status: string
  isPinned: boolean
}) {
  const [pending, startTransition] = useTransition()

  function handleTogglePin() {
    startTransition(() => {
      togglePinAction(timelineActivityId)
    })
  }

  if (status === "completed") return null

  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={pending}
        onClick={handleTogglePin}
      >
        {isPinned ? (
          <Pin className="h-4 w-4" />
        ) : (
          <PinOff className="h-4 w-4" />
        )}
        <span className="sr-only">{isPinned ? "Unpin" : "Pin"}</span>
      </Button>
    </div>
  )
}
