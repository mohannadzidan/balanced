import { Button } from "@/components/ui/button"

export function ActiveFocusCard() {
  return (
    <div className="flex-1 bg-foreground text-background rounded-[12px] p-4 shadow-floating relative overflow-hidden">
      <div className="flex flex-col">
        <span className="text-background text-sm font-semibold tracking-[-0.2px]">Freelance</span>
        <span className="text-xs text-muted-foreground">Preferred Window: 18:00 - 23:00</span>
      </div>
      <div className="text-center my-6">
        <div className="font-mono text-4xl font-medium tracking-[-1px] text-background">01:45:30</div>
        <div className="text-xs text-muted-foreground mt-1">Remaining until 21:30</div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button variant="outline" className="bg-muted border-border text-background py-2 text-xs font-medium">Extend +15m</Button>
        <Button variant="outline" className="bg-muted border-border text-background py-2 text-xs font-medium">Extend +30m</Button>
        <Button className="bg-background text-foreground py-2 text-xs font-medium">Finish Early</Button>
      </div>
    </div>
  )
}