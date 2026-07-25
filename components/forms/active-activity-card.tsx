"use client"

import { useEffect, useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { extendActivityAction, finishEarlyAction } from "@/lib/actions/execution"

function formatCountdown(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, "0")).join(":")
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/**
 * The "active" presentation of a started, not-yet-finished block (PRD's
 * Focus Mode countdown, story 31): a live countdown to its scheduled end,
 * with Extend/Finish Early controls. These controls only ever appear here —
 * an upcoming block has none of them.
 */
export function ActiveActivityCard({
  timelineActivityId,
  title,
  subtitle,
  endTime,
  children,
}: {
  timelineActivityId: string
  title: string
  subtitle: string
  endTime: Date
  children?: React.ReactNode
}) {
  const [now, setNow] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  function handleExtend(minutes: number) {
    startTransition(async () => {
      const result = await extendActivityAction(timelineActivityId, minutes)
      setError(result.ok ? null : result.error)
    })
  }

  function handleFinishEarly() {
    startTransition(async () => {
      const result = await finishEarlyAction(timelineActivityId)
      setError(result.ok ? null : result.error)
    })
  }

  const remainingMs = now ? endTime.getTime() - now.getTime() : null
  const overtime = remainingMs !== null && remainingMs < 0

  return (
    <div className="bg-foreground text-background rounded-[12px] p-4 shadow-floating relative overflow-hidden">
      <div className="flex flex-col">
        <span className="text-background text-sm font-semibold tracking-[-0.2px]">{title}</span>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </div>
      <div className="my-6 text-center">
        <div className="font-mono text-4xl font-medium tracking-[-1px] text-background tabular-nums">
          {remainingMs === null ? "--:--:--" : `${overtime ? "-" : ""}${formatCountdown(Math.abs(remainingMs))}`}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {overtime ? "Overtime since" : "Remaining until"} {formatClock(endTime)}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button
          type="button"
          variant="outline"
          className="bg-muted border-border text-background py-2 text-xs font-medium"
          disabled={pending}
          onClick={() => handleExtend(15)}
        >
          Extend +15m
        </Button>
        <Button
          type="button"
          variant="outline"
          className="bg-muted border-border text-background py-2 text-xs font-medium"
          disabled={pending}
          onClick={() => handleExtend(30)}
        >
          Extend +30m
        </Button>
        <Button
          type="button"
          className="bg-background text-foreground py-2 text-xs font-medium"
          disabled={pending}
          onClick={handleFinishEarly}
        >
          Finish Early
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      {children}
    </div>
  )
}
