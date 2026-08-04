interface GoalChipProps {
  color: string
  label: string
  current: string
  total: string
}

export function GoalChip({ color, label, current, total }: GoalChipProps) {
  return (
    <div className="shadow-whisper flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 whitespace-nowrap">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-xs font-medium text-foreground">{label}</span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {current} / {total}
      </span>
    </div>
  )
}
