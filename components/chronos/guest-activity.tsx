export function GuestActivity() {
  return (
    <div className="mt-3 ml-4 border-l border-primary pl-3">
      <div className="bg-primary/10 border border-primary/20 rounded-[8px] p-2 flex justify-between items-center">
        <div className="flex flex-col">
          <span className="text-primary text-sm font-medium">Lunch</span>
          <span className="text-xs text-primary">Guest Activity \u2022 30m used</span>
        </div>
        <span className="font-mono text-[10px] text-primary">13:00 - 13:30</span>
      </div>
    </div>
  )
}