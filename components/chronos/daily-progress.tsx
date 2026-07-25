import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { GoalChip } from "./goal-chip"
import { getTrackingProgressForToday } from "@/lib/db/tracking-queries"
import { todayISO } from "@/lib/time"

const CHIP_COLORS = ["var(--destructive)", "var(--foreground)", "var(--muted-foreground)", "var(--primary)"]

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
  const percent = totalTarget > 0 ? Math.min(100, Math.round((totalAchieved / totalTarget) * 100)) : 0

  return (
    <header className="relative overflow-hidden px-4 pt-8 pb-6 border-b border-border space-y-4">
      <div className="absolute top-0 left-0 w-full h-3/4 mesh-gradient -z-10" />
      <div className="flex justify-between items-end mb-4">
        <div>
          <span className="font-mono uppercase text-xs text-muted-foreground tracking-normal">Daily Progress</span>
          <h1 className="text-3xl font-semibold text-foreground tracking-[-1.2px] leading-none mt-2">
            {formatDuration(totalAchieved)}{" "}
            <span className="text-muted-foreground text-xl font-normal">/ {formatDuration(totalTarget)}</span>
          </h1>
        </div>
        {deficit > 0 && (
          <div className="flex flex-col items-end gap-1">
            <Badge variant="destructive" className="border border-warning/30 bg-warning-soft rounded-[6px] px-2 py-1 text-[10px]">
              +{formatDuration(deficit)} DEFICIT
            </Badge>
            <span className="text-xs text-muted-foreground">Carry-over active</span>
          </div>
        )}
      </div>
      <Progress className="w-full" value={percent}>
        <div className="h-full bg-foreground rounded-full" />
      </Progress>
      {progress.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar px-4 -mx-4">
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