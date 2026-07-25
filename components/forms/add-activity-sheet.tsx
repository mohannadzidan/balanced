"use client"

import { useRef, useState, useTransition } from "react"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { createActivityAction } from "@/lib/actions/activity"
import { WEEKDAYS, weekdayLabel } from "@/lib/weekdays"

export function AddActivitySheet() {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [windowKind, setWindowKind] = useState<"strict" | "flexible">("flexible")
  const formRef = useRef<HTMLFormElement>(null)

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await createActivityAction({ ok: false, error: "" }, formData)
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
          <Button className="flex-1 flex items-center justify-center gap-2 shadow-floating" />
        }
      >
        <Plus className="h-4 w-4" />
        Add Activity
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
          <SheetTitle>Add Activity</SheetTitle>
          <SheetDescription>
            Create a reusable blueprint. Attach rules afterward to define when and how it gets scheduled.
          </SheetDescription>
        </SheetHeader>
        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4 px-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activity-name">Name</Label>
            <Input id="activity-name" name="name" placeholder="Office Work" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Allowed days</Label>
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((day) => (
                <label key={day} className="flex items-center gap-1.5 text-sm text-foreground">
                  <Checkbox name="allowedDays" value={day} />
                  {weekdayLabel(day)}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activity-window-kind">Type</Label>
            <select
              id="activity-window-kind"
              name="windowKind"
              value={windowKind}
              onChange={(event) => setWindowKind(event.target.value as "strict" | "flexible")}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="flexible">Preferred (soft)</option>
              <option value="strict">Strict (hard)</option>
            </select>
          </div>
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="activity-window-start">{windowKind === "flexible" ? "Bounds start" : "Start"}</Label>
              <Input id="activity-window-start" name="windowStartMin" type="time" defaultValue="09:00" required />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="activity-window-end">{windowKind === "flexible" ? "Bounds end" : "End"}</Label>
              <Input id="activity-window-end" name="windowEndMin" type="time" defaultValue="10:00" required />
            </div>
          </div>
          {windowKind === "flexible" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="activity-window-duration">Duration (hours)</Label>
              <Input
                id="activity-window-duration"
                name="windowDurationHours"
                type="number"
                min={0.25}
                step={0.25}
                defaultValue={8}
                required
              />
              <p className="text-xs text-muted-foreground">
                How long the block actually runs — it can land anywhere inside the bounds above.
              </p>
            </div>
          )}
          <label className="flex items-start gap-1.5 text-sm text-foreground">
            <Checkbox name="isTransitionOnly" className="mt-0.5" />
            <span>
              Transition only
              <span className="block text-xs text-muted-foreground">
                Only ever scheduled as part of another activity&apos;s Sequence Rule (e.g. Commute
                before Office Work) — never scheduled on its own.
              </span>
            </span>
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <SheetFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save Activity"}
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
