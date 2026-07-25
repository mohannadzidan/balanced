import { ChronosNav } from "@/components/chronos/chronos-nav"
import { DailyProgress } from "@/components/chronos/daily-progress"
import { DevTools } from "@/components/chronos/dev-tools"
import { Schedule } from "@/components/chronos/schedule"
import { ActivityTemplates } from "@/components/chronos/activity-templates"
import { ActionBar } from "@/components/chronos/action-bar"

export default function Page() {
  return (
    <div className="max-w-md mx-auto bg-background min-h-screen relative border-x border-border pb-32">
      <ChronosNav />
      <DailyProgress />
      <DevTools />
      <Schedule />
      <ActivityTemplates />
      <ActionBar />
    </div>
  )
}