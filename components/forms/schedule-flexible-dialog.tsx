"use client"

import { useActionState, useState } from "react"

import { scheduleFlexibleBlock } from "@/app/actions"
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
import type { FlexibleActivity } from "@/lib/domain/types"
import type { ActionState } from "@/lib/domain/validation"

const initialState: ActionState = { ok: true }

export type ScheduleFlexibleDialogProps = {
  activities: FlexibleActivity[]
}

/**
 * Schedule a standalone Flexible block (FR-015, contracts/server-actions.md
 * §2): pick a Flexible activity and a start time; the action computes the
 * end from the activity's minimum block. A Soft (Preferred Window)
 * violation still saves — its `warnings` render separately from
 * `formErrors`, which carry only Hard rejections (FR-017, SC-004).
 */
export function ScheduleFlexibleDialog({ activities }: ScheduleFlexibleDialogProps) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(
    scheduleFlexibleBlock,
    initialState
  )

  // A successful save with no warning closes the dialog like Add Activity
  // does. A Soft (Preferred Window) violation still saves, but the dialog
  // stays open so its warning is actually seen — the timeline's derived
  // badge (FR-017) is what keeps the flag visible after that.
  const [prevState, setPrevState] = useState(state)
  if (state !== prevState) {
    setPrevState(state)
    if (state.ok && (state.warnings === undefined || state.warnings.length === 0)) {
      setOpen(false)
    }
  }

  const fieldErrors = state.ok ? {} : state.fieldErrors
  const formErrors = state.ok ? [] : state.formErrors
  const warnings = state.ok ? (state.warnings ?? []) : []

  if (activities.length === 0) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        Schedule Block
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule Block</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          {formErrors.length > 0 && (
            <p className="text-sm text-destructive">{formErrors.join(" ")}</p>
          )}

          {warnings.length > 0 && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {warnings.join(" ")}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activityId">Activity</Label>
            <Select name="activityId" defaultValue={activities[0].id}>
              <SelectTrigger id="activityId">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {activities.map((activity) => (
                  <SelectItem key={activity.id} value={activity.id}>
                    {activity.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldErrors.activityId?.map((message) => (
              <p key={message} className="text-sm text-destructive">
                {message}
              </p>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="startMin">Start</Label>
            <Input id="startMin" name="startMin" type="time" required />
            {fieldErrors.startMin?.map((message) => (
              <p key={message} className="text-sm text-destructive">
                {message}
              </p>
            ))}
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
