"use client"

import { useActionState, useState } from "react"

import { createActivity } from "@/app/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ActionState } from "@/lib/domain/validation"

const initialState: ActionState = { ok: true }

/**
 * Add Activity: name, Constraint Type, and the Strict Window start/end
 * (contracts/server-actions.md §1). Only "Strict" exists as a constraint
 * type until Flexible arrives (T043) — `placementKind` mirrors it as a
 * hidden field since a Strict activity's placement kind is never a choice.
 */
export function AddActivityDialog() {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(
    createActivity,
    initialState
  )

  // Adjust `open` during render rather than in an effect (React's "storing
  // information from previous renders" pattern): a fresh, successful action
  // result closes the dialog; DialogContent unmounts on close, so its form's
  // uncontrolled inputs come back empty next time it opens.
  const [prevState, setPrevState] = useState(state)
  if (state !== prevState) {
    setPrevState(state)
    if (state.ok) {
      setOpen(false)
    }
  }

  // The Start field stays an uncontrolled native input (see the reset note
  // above); this state only tracks its value so the End field's `min` can
  // rule out times at or before it, both in the browser's own time picker
  // and via its built-in constraint validation on submit (FR-005).
  const [startTime, setStartTime] = useState("")
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (!open) {
      setStartTime("")
    }
  }

  const fieldErrors = state.ok ? {} : state.fieldErrors
  const formErrors = state.ok ? [] : state.formErrors

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Add Activity</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Activity</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="placementKind" value="strict" />

          {formErrors.length > 0 && (
            <p className="text-sm text-destructive">{formErrors.join(" ")}</p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required />
            {fieldErrors.name?.map((message) => (
              <p key={message} className="text-sm text-destructive">
                {message}
              </p>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="constraintType">Constraint Type</Label>
            <Select name="constraintType" defaultValue="strict">
              <SelectTrigger id="constraintType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="strict">Strict</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="placementStartMin">Start</Label>
              <Input
                id="placementStartMin"
                name="placementStartMin"
                type="time"
                required
                onChange={(event) => setStartTime(event.target.value)}
              />
              {fieldErrors.placementStartMin?.map((message) => (
                <p key={message} className="text-sm text-destructive">
                  {message}
                </p>
              ))}
            </div>

            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="placementEndMin">End</Label>
              <Input
                id="placementEndMin"
                name="placementEndMin"
                type="time"
                required
                min={startTime || undefined}
              />
              {fieldErrors.placementEndMin?.map((message) => (
                <p key={message} className="text-sm text-destructive">
                  {message}
                </p>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
