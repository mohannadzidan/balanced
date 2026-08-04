"use client"

import { useRef, useState, useTransition } from "react"
import { Calendar } from "lucide-react"

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
import { createOneOffActivityAction } from "@/lib/actions/execution"

export function OneOffEventSheet() {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await createOneOffActivityAction(
        { ok: false, error: "" },
        formData
      )
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
      <SheetTrigger
        render={
          <Button
            variant="outline"
            className="shadow-whisper flex flex-1 items-center justify-center gap-2"
          />
        }
      >
        <Calendar className="h-4 w-4" />
        One-Time Event
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto rounded-t-2xl border-t-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div
          aria-hidden
          className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted"
        />
        <SheetHeader>
          <SheetTitle>One-Time Event</SheetTitle>
          <SheetDescription>
            Exists only on today&apos;s timeline — your global activity
            templates are untouched.
          </SheetDescription>
        </SheetHeader>
        <form
          ref={formRef}
          action={handleSubmit}
          className="flex flex-col gap-4 px-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="one-off-title">Name</Label>
            <Input
              id="one-off-title"
              name="title"
              placeholder="Pick up dry cleaning"
              required
            />
          </div>
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="one-off-start">Start</Label>
              <Input
                id="one-off-start"
                name="startMin"
                type="time"
                defaultValue="09:00"
                required
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="one-off-end">End</Label>
              <Input
                id="one-off-end"
                name="endMin"
                type="time"
                defaultValue="09:30"
                required
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <SheetFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Add to Today"}
            </Button>
            <SheetClose render={<Button type="button" variant="outline" />}>
              Cancel
            </SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
