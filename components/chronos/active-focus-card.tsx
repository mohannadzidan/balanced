import { Button } from "@/components/ui/button"

export function ActiveFocusCard() {
  return (
    <div className="shadow-floating relative flex-1 overflow-hidden rounded-[12px] bg-foreground p-4 text-background">
      <div className="flex flex-col">
        <span className="text-sm font-semibold tracking-[-0.2px] text-background">
          Freelance
        </span>
        <span className="text-xs text-muted-foreground">
          Preferred Window: 18:00 - 23:00
        </span>
      </div>
      <div className="my-6 text-center">
        <div className="font-mono text-4xl font-medium tracking-[-1px] text-background">
          01:45:30
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Remaining until 21:30
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button
          variant="outline"
          className="border-border bg-muted py-2 text-xs font-medium text-background"
        >
          Extend +15m
        </Button>
        <Button
          variant="outline"
          className="border-border bg-muted py-2 text-xs font-medium text-background"
        >
          Extend +30m
        </Button>
        <Button className="bg-background py-2 text-xs font-medium text-foreground">
          Finish Early
        </Button>
      </div>
    </div>
  )
}
