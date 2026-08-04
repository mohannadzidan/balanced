export function GuestActivity() {
  return (
    <div className="mt-3 ml-4 border-l border-primary pl-3">
      <div className="flex items-center justify-between rounded-[8px] border border-primary/20 bg-primary/10 p-2">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-primary">Lunch</span>
          <span className="text-xs text-primary">
            Guest Activity \u2022 30m used
          </span>
        </div>
        <span className="font-mono text-[10px] text-primary">
          13:00 - 13:30
        </span>
      </div>
    </div>
  )
}
