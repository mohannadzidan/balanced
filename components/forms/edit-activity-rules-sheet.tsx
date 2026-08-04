"use client"

import { useState, useTransition } from "react"
import { Settings2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  deleteActivityAction,
  updateActivityDetailsAction,
  type ActivityFormState,
} from "@/lib/actions/activity"
import {
  addVacationDayAction,
  deleteRuleAction,
  removeVacationDayAction,
  saveOverlapRuleAction,
  saveSequenceRuleAction,
  saveTrackingRuleAction,
  saveWindowRuleAction,
  type RuleFormState,
} from "@/lib/actions/rules"
import { NONE_OPTION } from "@/lib/rules/constants"
import { formatHHMM } from "@/lib/time"
import type { ActivityRules, RuleType } from "@/lib/rules/types"
import { WEEKDAYS, weekdayLabel, type Weekday } from "@/lib/weekdays"

const emptyState: RuleFormState = { ok: false, error: "" }
const emptyActivityState: ActivityFormState = { ok: false, error: "" }

const selectClassName =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"

const RULE_TYPES: RuleType[] = ["window", "sequence", "overlap", "tracking"]

const RULE_LABELS: Record<RuleType, string> = {
  window: "Window Rule",
  sequence: "Sequence Rule",
  overlap: "Overlap Rule",
  tracking: "Tracking Rule",
}

function windowSummary(rule: ActivityRules["window"]): string {
  if (!rule) return ""
  const spansMidnight = rule.endMin <= rule.startMin
  const range = `${formatHHMM(rule.startMin)}–${formatHHMM(rule.endMin)}${spansMidnight ? " (+1 day)" : ""}`
  if (rule.kind === "strict") return `Strict · ${range}`
  const hours = rule.durationMin / 60
  const durationLabel = Number.isInteger(hours)
    ? `${hours}h`
    : `${hours.toFixed(1)}h`
  return `Preferred · ${durationLabel} within ${range}`
}

function sequenceSummary(
  rule: ActivityRules["sequence"],
  nameById: Map<string, string>
): string {
  if (!rule) return ""
  const parts: string[] = []
  if (rule.preActivityId)
    parts.push(`Pre: ${nameById.get(rule.preActivityId) ?? "Unknown"}`)
  if (rule.postActivityId)
    parts.push(`Post: ${nameById.get(rule.postActivityId) ?? "Unknown"}`)
  return parts.length > 0 ? parts.join(" · ") : "No links set"
}

function overlapSummary(rule: ActivityRules["overlap"]): string {
  if (!rule) return ""
  const count = rule.guestActivityIds.length
  return `${rule.budgetMin}m budget · ${count} guest${count === 1 ? "" : "s"}`
}

function trackingSummary(rule: ActivityRules["tracking"]): string {
  if (!rule) return ""
  const cap = rule.capMin !== null ? `, cap ${rule.capMin}m` : ""
  return `${rule.dailyTargetMin}m/day · min block ${rule.minBlockMinutes}m · carry-over ${rule.carryOverEnabled ? "on" : "off"}${cap}`
}

function WindowRuleForm({
  activityId,
  initial,
  onSaved,
}: {
  activityId: string
  initial: ActivityRules["window"]
  onSaved: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [kind, setKind] = useState<"strict" | "flexible">(
    initial?.kind ?? "flexible"
  )

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await saveWindowRuleAction(
        activityId,
        emptyState,
        formData
      )
      if (result.ok) {
        setError(null)
        onSaved()
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <form action={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${activityId}-window-kind`}>Type</Label>
        <select
          id={`${activityId}-window-kind`}
          name="kind"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as "strict" | "flexible")
          }
          className={selectClassName}
        >
          <option value="flexible">Preferred (soft)</option>
          <option value="strict">Strict (hard)</option>
        </select>
      </div>
      <div className="flex gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`${activityId}-window-start`}>
            {kind === "flexible" ? "Bounds start" : "Start"}
          </Label>
          <Input
            id={`${activityId}-window-start`}
            name="startMin"
            type="time"
            defaultValue={initial ? formatHHMM(initial.startMin) : "09:00"}
            required
          />
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`${activityId}-window-end`}>
            {kind === "flexible" ? "Bounds end" : "End"}
          </Label>
          <Input
            id={`${activityId}-window-end`}
            name="endMin"
            type="time"
            defaultValue={initial ? formatHHMM(initial.endMin) : "10:00"}
            required
          />
        </div>
      </div>
      {kind === "flexible" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${activityId}-window-duration`}>
            Duration (hours)
          </Label>
          <Input
            id={`${activityId}-window-duration`}
            name="durationHours"
            type="number"
            min={0.25}
            step={0.25}
            defaultValue={
              initial?.kind === "flexible" ? initial.durationMin / 60 : 8
            }
            required
          />
          <p className="text-xs text-muted-foreground">
            How long the block actually runs — it can land anywhere inside the
            bounds above.
          </p>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save Window Rule"}
      </Button>
    </form>
  )
}

function SequenceRuleForm({
  activityId,
  initial,
  otherActivities,
  onSaved,
}: {
  activityId: string
  initial: ActivityRules["sequence"]
  otherActivities: { id: string; name: string }[]
  onSaved: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await saveSequenceRuleAction(
        activityId,
        emptyState,
        formData
      )
      if (result.ok) {
        setError(null)
        onSaved()
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <form action={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${activityId}-pre-activity`}>Pre-activity</Label>
        <select
          id={`${activityId}-pre-activity`}
          name="preActivityId"
          defaultValue={initial?.preActivityId ?? NONE_OPTION}
          className={selectClassName}
        >
          <option value={NONE_OPTION}>None</option>
          {otherActivities.map((activity) => (
            <option key={activity.id} value={activity.id}>
              {activity.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${activityId}-post-activity`}>Post-activity</Label>
        <select
          id={`${activityId}-post-activity`}
          name="postActivityId"
          defaultValue={initial?.postActivityId ?? NONE_OPTION}
          className={selectClassName}
        >
          <option value={NONE_OPTION}>None</option>
          {otherActivities.map((activity) => (
            <option key={activity.id} value={activity.id}>
              {activity.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save Sequence Rule"}
      </Button>
    </form>
  )
}

function OverlapRuleForm({
  activityId,
  initial,
  otherActivities,
  onSaved,
}: {
  activityId: string
  initial: ActivityRules["overlap"]
  otherActivities: { id: string; name: string }[]
  onSaved: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await saveOverlapRuleAction(
        activityId,
        emptyState,
        formData
      )
      if (result.ok) {
        setError(null)
        onSaved()
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <form action={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${activityId}-budget`}>Overlap budget (minutes)</Label>
        <Input
          id={`${activityId}-budget`}
          name="budgetMin"
          type="number"
          min={0}
          step={1}
          defaultValue={initial?.budgetMin ?? 0}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Allowed guests</Label>
        {otherActivities.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Create another activity to allow it as a guest.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {otherActivities.map((activity) => (
              <label
                key={activity.id}
                className="flex items-center gap-1.5 text-sm text-foreground"
              >
                <Checkbox
                  name="guestActivityIds"
                  value={activity.id}
                  defaultChecked={
                    initial?.guestActivityIds.includes(activity.id) ?? false
                  }
                />
                {activity.name}
              </label>
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save Overlap Rule"}
      </Button>
    </form>
  )
}

function VacationDaysManager({
  activityId,
  initialVacationDays,
}: {
  activityId: string
  initialVacationDays: string[]
}) {
  const [pending, startTransition] = useTransition()
  const [newDate, setNewDate] = useState("")

  function handleAdd() {
    if (!newDate) return
    startTransition(async () => {
      await addVacationDayAction(activityId, newDate)
      setNewDate("")
    })
  }

  function handleRemove(date: string) {
    startTransition(async () => {
      await removeVacationDayAction(activityId, date)
    })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>Vacation days</Label>
      {initialVacationDays.length > 0 && (
        <ul className="flex flex-col gap-1">
          {initialVacationDays.map((date) => (
            <li
              key={date}
              className="flex items-center justify-between text-sm text-foreground"
            >
              {date}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => handleRemove(date)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          type="date"
          value={newDate}
          onChange={(event) => setNewDate(event.target.value)}
          className="flex-1"
        />
        <Button
          type="button"
          size="sm"
          disabled={pending || !newDate}
          onClick={handleAdd}
        >
          Add
        </Button>
      </div>
    </div>
  )
}

function TrackingRuleForm({
  activityId,
  initial,
  initialVacationDays,
  onSaved,
}: {
  activityId: string
  initial: ActivityRules["tracking"]
  initialVacationDays: string[]
  onSaved: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await saveTrackingRuleAction(
        activityId,
        emptyState,
        formData
      )
      if (result.ok) {
        setError(null)
        onSaved()
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={handleSubmit} className="flex flex-col gap-3">
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor={`${activityId}-target`}>Daily target (min)</Label>
            <Input
              id={`${activityId}-target`}
              name="dailyTargetMin"
              type="number"
              min={1}
              step={1}
              defaultValue={initial?.dailyTargetMin ?? 60}
              required
            />
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor={`${activityId}-min-block`}>Min block (min)</Label>
            <Input
              id={`${activityId}-min-block`}
              name="minBlockMinutes"
              type="number"
              min={1}
              step={1}
              defaultValue={initial?.minBlockMinutes ?? 15}
              required
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${activityId}-cap`}>Daily cap (min, optional)</Label>
          <Input
            id={`${activityId}-cap`}
            name="capMin"
            type="number"
            min={0}
            step={1}
            defaultValue={initial?.capMin ?? ""}
            placeholder="No cap"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-foreground">
          <Checkbox
            name="carryOverEnabled"
            defaultChecked={initial?.carryOverEnabled ?? true}
          />
          Carry deficits/surpluses forward
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save Tracking Rule"}
        </Button>
      </form>
      {initial && (
        <VacationDaysManager
          activityId={activityId}
          initialVacationDays={initialVacationDays}
        />
      )}
    </div>
  )
}

function ActivityDetailsForm({
  activityId,
  initialName,
  initialAllowedDays,
  initialIsTransitionOnly,
}: {
  activityId: string
  initialName: string
  initialAllowedDays: Weekday[]
  initialIsTransitionOnly: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await updateActivityDetailsAction(
        activityId,
        emptyActivityState,
        formData
      )
      if (result.ok) {
        setError(null)
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <form
      action={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${activityId}-name`}>Name</Label>
        <Input
          id={`${activityId}-name`}
          name="name"
          defaultValue={initialName}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Allowed days</Label>
        <div className="flex flex-wrap gap-3">
          {WEEKDAYS.map((day) => (
            <label
              key={day}
              className="flex items-center gap-1.5 text-sm text-foreground"
            >
              <Checkbox
                name="allowedDays"
                value={day}
                defaultChecked={initialAllowedDays.includes(day)}
              />
              {weekdayLabel(day)}
            </label>
          ))}
        </div>
      </div>
      <label className="flex items-start gap-1.5 text-sm text-foreground">
        <Checkbox
          name="isTransitionOnly"
          className="mt-0.5"
          defaultChecked={initialIsTransitionOnly}
        />
        <span>
          Transition only
          <span className="block text-xs text-muted-foreground">
            Only ever scheduled as part of another activity&apos;s Sequence Rule
            — never scheduled on its own.
          </span>
        </span>
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save Details"}
      </Button>
    </form>
  )
}

function DeleteActivityButton({
  activityId,
  activityName,
}: {
  activityId: string
  activityName: string
}) {
  const [pending, startTransition] = useTransition()

  function handleClick() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete "${activityName}"? This also removes its rules.`)
    ) {
      return
    }
    startTransition(async () => {
      await deleteActivityAction(activityId)
    })
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      onClick={handleClick}
      disabled={pending}
    >
      {pending ? "Deleting…" : "Delete Activity"}
    </Button>
  )
}

function DeleteRuleButton({
  activityId,
  type,
  onDeleted,
}: {
  activityId: string
  type: RuleType
  onDeleted: () => void
}) {
  const [pending, startTransition] = useTransition()

  function handleClick() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Remove the ${RULE_LABELS[type]}?`)
    ) {
      return
    }
    startTransition(async () => {
      await deleteRuleAction(activityId, type)
      onDeleted()
    })
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleClick}
      disabled={pending}
    >
      {pending ? "Removing…" : "Delete"}
    </Button>
  )
}

function RuleForm({
  type,
  activityId,
  initialRules,
  initialVacationDays,
  otherActivities,
  onSaved,
}: {
  type: RuleType
  activityId: string
  initialRules: ActivityRules
  initialVacationDays: string[]
  otherActivities: { id: string; name: string }[]
  onSaved: () => void
}) {
  if (type === "window") {
    return (
      <WindowRuleForm
        activityId={activityId}
        initial={initialRules.window}
        onSaved={onSaved}
      />
    )
  }
  if (type === "sequence") {
    return (
      <SequenceRuleForm
        activityId={activityId}
        initial={initialRules.sequence}
        otherActivities={otherActivities}
        onSaved={onSaved}
      />
    )
  }
  if (type === "overlap") {
    return (
      <OverlapRuleForm
        activityId={activityId}
        initial={initialRules.overlap}
        otherActivities={otherActivities}
        onSaved={onSaved}
      />
    )
  }
  return (
    <TrackingRuleForm
      activityId={activityId}
      initial={initialRules.tracking}
      initialVacationDays={initialVacationDays}
      onSaved={onSaved}
    />
  )
}

export function EditActivityRulesSheet({
  activityId,
  activityName,
  initialAllowedDays,
  initialIsTransitionOnly,
  initialRules,
  initialVacationDays,
  otherActivities,
}: {
  activityId: string
  activityName: string
  initialAllowedDays: Weekday[]
  initialIsTransitionOnly: boolean
  initialRules: ActivityRules
  initialVacationDays: string[]
  otherActivities: { id: string; name: string }[]
}) {
  const [activeRuleType, setActiveRuleType] = useState<RuleType | null>(null)

  const nameById = new Map(
    otherActivities.map((activity) => [activity.id, activity.name])
  )
  const configuredTypes = RULE_TYPES.filter(
    (type) => initialRules[type] !== null
  )
  const eligibleTypes = RULE_TYPES.filter((type) => initialRules[type] === null)

  function close() {
    setActiveRuleType(null)
  }

  function summaryFor(type: RuleType): string {
    if (type === "window") return windowSummary(initialRules.window)
    if (type === "sequence")
      return sequenceSummary(initialRules.sequence, nameById)
    if (type === "overlap") return overlapSummary(initialRules.overlap)
    return trackingSummary(initialRules.tracking)
  }

  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <SheetTrigger render={<Button variant="ghost" size="icon-sm" />}>
        <Settings2 className="h-4 w-4" />
        <span className="sr-only">Configure {activityName}</span>
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
          <SheetTitle>Configure {activityName}</SheetTitle>
          <SheetDescription>
            An activity can carry at most one rule of each type.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4">
          <ActivityDetailsForm
            activityId={activityId}
            initialName={activityName}
            initialAllowedDays={initialAllowedDays}
            initialIsTransitionOnly={initialIsTransitionOnly}
          />

          {configuredTypes.map((type) => (
            <div key={type} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {RULE_LABELS[type]}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {summaryFor(type)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setActiveRuleType(activeRuleType === type ? null : type)
                    }
                  >
                    {activeRuleType === type ? "Cancel" : "Edit"}
                  </Button>
                  <DeleteRuleButton
                    activityId={activityId}
                    type={type}
                    onDeleted={close}
                  />
                </div>
              </div>
              {activeRuleType === type && (
                <div className="mt-3">
                  <RuleForm
                    type={type}
                    activityId={activityId}
                    initialRules={initialRules}
                    initialVacationDays={initialVacationDays}
                    otherActivities={otherActivities}
                    onSaved={close}
                  />
                </div>
              )}
            </div>
          ))}

          {eligibleTypes.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
              <Label>Add a rule</Label>
              <Select
                value={
                  activeRuleType && eligibleTypes.includes(activeRuleType)
                    ? activeRuleType
                    : undefined
                }
                onValueChange={(value) => setActiveRuleType(value as RuleType)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a rule type…" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {RULE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeRuleType && eligibleTypes.includes(activeRuleType) && (
                <div className="mt-1">
                  <RuleForm
                    type={activeRuleType}
                    activityId={activityId}
                    initialRules={initialRules}
                    initialVacationDays={initialVacationDays}
                    otherActivities={otherActivities}
                    onSaved={close}
                  />
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              All rule types are configured.
            </p>
          )}

          <div className="border-t border-border pt-3">
            <DeleteActivityButton
              activityId={activityId}
              activityName={activityName}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
