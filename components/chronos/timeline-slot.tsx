export function TimelineSlot({ time, children }: { time: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="font-mono text-xs text-muted-foreground mt-3 w-10 text-right shrink-0">{time}</div>
      <div className="flex-1">{children}</div>
    </div>
  )
}