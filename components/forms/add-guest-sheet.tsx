"use client"

import { useRef, useState, useTransition } from "react"
import { UserPlus } from "lucide-react"

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
import { manualPlaceGuestActivityAction } from "@/lib/actions/manual"

export function AddGuestSheet({
  hostTimelineActivityId,
  hostTitle,
  remainingMin,
  guestOptions,
}: {
  hostTimelineActivityId: string
  hostTitle: string
  remainingMin: number
  guestOptions: { id: string; name: string }[]
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await manualPlaceGuestActivityAction(hostTimelineActivityId, { ok: false, error: "" }, formData)
      if (result.ok) {
        formRef.current?.reset()
        setError(null)
        setOpen(false)
      } else {
        setError(result.error)
      }
    })
  }

  if (guestOptions.length === 0) return null

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <UserPlus className="h-4 w-4" />
        Add Guest
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto rounded-t-2xl border-t-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div aria-hidden className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted" />
        <SheetHeader>
          <SheetTitle>Add a Guest to {hostTitle}</SheetTitle>
          <SheetDescription>{remainingMin}m of overlap budget remaining.</SheetDescription>
        </SheetHeader>
        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4 px-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${hostTimelineActivityId}-guest`}>Activity</Label>
            <select
              id={`${hostTimelineActivityId}-guest`}
              name="guestActivityId"
              defaultValue={guestOptions[0]?.id}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {guestOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`${hostTimelineActivityId}-guest-start`}>Start</Label>
              <Input id={`${hostTimelineActivityId}-guest-start`} name="startMin" type="time" required />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`${hostTimelineActivityId}-guest-end`}>End</Label>
              <Input id={`${hostTimelineActivityId}-guest-end`} name="endMin" type="time" required />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <SheetFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add Guest"}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>Cancel</SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
