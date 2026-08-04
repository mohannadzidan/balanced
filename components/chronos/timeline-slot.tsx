export function TimelineSlot({
  time,
  children,
}: {
  time: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-3 w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {time}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}
