import { ChronosNav } from "@/components/chronos/chronos-nav"
import { DailyProgress } from "@/components/chronos/daily-progress"
import { DevTools } from "@/components/chronos/dev-tools"
import { Schedule } from "@/components/chronos/schedule"
import { ActivityTemplates } from "@/components/chronos/activity-templates"
import { ActionBar } from "@/components/chronos/action-bar"
import { FinishEarlyProvider } from "@/components/forms/finish-early-provider"

export default function Page() {
  return (
    <div className="relative mx-auto min-h-screen max-w-md border-x border-border bg-background pb-32">
      <ChronosNav />
      <DailyProgress />
      <DevTools />
      <FinishEarlyProvider>
        <Schedule />
      </FinishEarlyProvider>
      <ActivityTemplates />
      <ActionBar />
    </div>
  )
}
