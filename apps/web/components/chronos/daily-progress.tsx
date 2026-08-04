import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { GoalChip } from "./goal-chip"
import { getTrackingProgressForToday } from "@/lib/db/tracking-queries"
import { todayISO } from "@/lib/time"

const CHIP_COLORS = [
  "var(--destructive)",
  "var(--foreground)",
  "var(--muted-foreground)",
  "var(--primary)",
]

function formatDuration(min: number): string {
  const hours = Math.floor(min / 60)
  const minutes = min % 60
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

export async function DailyProgress() {
  const progress = await getTrackingProgressForToday(todayISO())

  const totalTarget = progress.reduce((sum, p) => sum + p.targetMin, 0)
  const totalAchieved = progress.reduce((sum, p) => sum + p.achievedTodayMin, 0)
  const deficit = totalTarget - totalAchieved
  const percent =
    totalTarget > 0
      ? Math.min(100, Math.round((totalAchieved / totalTarget) * 100))
      : 0

  return (
    <header className="relative space-y-4 overflow-hidden border-b border-border px-4 pt-8 pb-6">
      <div className="mesh-gradient absolute top-0 left-0 -z-10 h-3/4 w-full" />
      <div className="mb-4 flex items-end justify-between">
        <div>
          <span className="font-mono text-xs tracking-normal text-muted-foreground uppercase">
            Daily Progress
          </span>
          <h1 className="mt-2 text-3xl leading-none font-semibold tracking-[-1.2px] text-foreground">
            {formatDuration(totalAchieved)}{" "}
            <span className="text-xl font-normal text-muted-foreground">
              / {formatDuration(totalTarget)}
            </span>
          </h1>
        </div>
        {deficit > 0 && (
          <div className="flex flex-col items-end gap-1">
            <Badge
              variant="destructive"
              className="border-warning/30 bg-warning-soft rounded-[6px] border px-2 py-1 text-[10px]"
            >
              +{formatDuration(deficit)} DEFICIT
            </Badge>
            <span className="text-xs text-muted-foreground">
              Carry-over active
            </span>
          </div>
        )}
      </div>
      <Progress className="w-full" value={percent}>
        <div className="h-full rounded-full bg-foreground" />
      </Progress>
      {progress.length > 0 && (
        <div className="-mx-4 no-scrollbar flex gap-2 overflow-x-auto px-4 pb-1">
          {progress.map((p, i) => (
            <GoalChip
              key={p.activityId}
              color={CHIP_COLORS[i % CHIP_COLORS.length]}
              label={p.activityName}
              current={formatDuration(p.achievedTodayMin)}
              total={formatDuration(p.targetMin)}
            />
          ))}
        </div>
      )}
    </header>
  )
}
