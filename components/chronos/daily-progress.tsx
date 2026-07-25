import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { GoalChip } from "./goal-chip"

const goals = [
  { color: "var(--destructive)", label: "Freelance", current: "0h", total: "5h" },
  { color: "var(--foreground)", label: "Learning", current: "1h", total: "1h" },
  { color: "var(--muted-foreground)", label: "Sleep", current: "0h", total: "8h" },
]

export function DailyProgress() {
  return (
    <header className="relative overflow-hidden px-4 pt-8 pb-6 border-b border-border space-y-4">
      <div className="absolute top-0 left-0 w-full h-3/4 mesh-gradient -z-10" />
      <div className="flex justify-between items-end mb-4">
        <div>
          <span className="font-mono uppercase text-xs text-muted-foreground tracking-normal">Daily Progress</span>
          <h1 className="text-3xl font-semibold text-foreground tracking-[-1.2px] leading-none mt-2">
            4h 30m <span className="text-muted-foreground text-xl font-normal">/ 8h</span>
          </h1>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant="destructive" className="border border-warning/30 bg-warning-soft rounded-[6px] px-2 py-1 text-[10px]">
            +1h DEFICIT
          </Badge>
          <span className="text-xs text-muted-foreground">Carry-over active</span>
        </div>
      </div>
      <Progress className="w-full" value={56}>
        <div className="h-full bg-foreground rounded-full" />
      </Progress>
      <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar px-4 -mx-4">
        {goals.map((g, i) => (
          <GoalChip key={i} {...g} />
        ))}
      </div>
    </header>
  )
}