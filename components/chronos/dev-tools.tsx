"use client"

import { useTransition } from "react"

import { Button } from "@/components/ui/button"
import {
  resetAndRegenerateTimelineAction,
  seedOvernightSleepFixtureAction,
} from "@/lib/actions/dev"

/** TEMPORARY — testing scaffolding for the generator/midnight-spanning behavior. Remove when done. */
export function DevTools() {
  const [pending, startTransition] = useTransition()

  return (
    <div className="mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 p-3">
      <span className="font-mono text-[10px] tracking-wide text-destructive uppercase">
        Dev Tools
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(() => resetAndRegenerateTimelineAction())
        }
      >
        Reschedule From Scratch (w/ Overnight Sleep)
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => startTransition(() => seedOvernightSleepFixtureAction())}
      >
        Seed Overnight Sleep Only
      </Button>
    </div>
  )
}
