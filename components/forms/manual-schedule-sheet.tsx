"use client"

import { useRef, useState, useTransition } from "react"
import { CalendarClock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { manualScheduleActivityAction } from "@/lib/actions/manual"

export function ManualScheduleSheet({
  activityId,
  activityName,
}: {
  activityId: string
  activityName: string
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await manualScheduleActivityAction(activityId, { ok: false, error: "" }, formData)
      if (result.ok) {
        formRef.current?.reset()
        setError(null)
        setOpen(false)
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon-sm" />}>
        <CalendarClock className="h-4 w-4" />
        <span className="sr-only">Schedule {activityName} manually</span>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto rounded-t-2xl border-t-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div aria-hidden className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted" />
        <SheetHeader>
          <SheetTitle>Schedule {activityName}</SheetTitle>
          <SheetDescription>Place this block yourself instead of leaving it to the solver.</SheetDescription>
        </SheetHeader>
        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4 px-4">
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`${activityId}-manual-start`}>Start</Label>
              <Input id={`${activityId}-manual-start`} name="startMin" type="time" defaultValue="09:00" required />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`${activityId}-manual-end`}>End</Label>
              <Input id={`${activityId}-manual-end`} name="endMin" type="time" defaultValue="09:30" required />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <SheetFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Placing…" : "Place on Timeline"}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>Cancel</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
