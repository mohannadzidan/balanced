"use client"

import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { acceptSpareTimeActivityAction, finishGuestEarlyAction } from "@/lib/actions/overlap"
import type { SpareTimePrompt } from "@/lib/db/overlap-queries"

export function GuestActivityActions({
  timelineActivityId,
  status,
  hasStarted,
}: {
  timelineActivityId: string
  status: string
  hasStarted: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<SpareTimePrompt | null>(null)
  const [pending, startTransition] = useTransition()

  function handleFinishEarly() {
    startTransition(async () => {
      const result = await finishGuestEarlyAction(timelineActivityId)
      if (result.ok) {
        setError(null)
        setPrompt(result.prompt)
      } else {
        setError(result.error)
      }
    })
  }

  function handleAccept(guestActivityId: string, durationMin: number) {
    if (!prompt) return
    startTransition(async () => {
      const result = await acceptSpareTimeActivityAction({
        hostTimelineActivityId: prompt.hostTimelineActivityId,
        guestActivityId,
        freedStartIso: prompt.freedStartIso,
        durationMin,
      })
      if (result.ok) {
        setError(null)
        setPrompt(null)
      } else {
        setError(result.error)
      }
    })
  }

  if (prompt) {
    return (
      <div className="mt-2 rounded-lg border border-dashed border-border p-2">
        <p className="text-xs text-foreground">
          You have {prompt.freedMin}m spare. Tackle a quick activity, or just rest?
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {prompt.quickActivities.map((activity) => (
            <Button
              key={activity.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => handleAccept(activity.id, activity.suggestedDurationMin)}
            >
              {activity.name} ({activity.suggestedDurationMin}m)
            </Button>
          ))}
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setPrompt(null)}>
            Just rest
          </Button>
        </div>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  if (status === "completed" || !hasStarted) return null

  return (
    <div className="mt-2">
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={handleFinishEarly}>
        Finish Early
      </Button>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
