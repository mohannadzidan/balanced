import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

export function ChronosNav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="flex items-center justify-between px-4 py-3">
        <Button variant="ghost" size="icon" className="-ml-2 rounded-full" aria-label="Previous day">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="flex flex-col items-center">
          <span className="text-base font-semibold text-foreground tracking-[-0.2px] leading-none">Today</span>
          <span className="font-mono text-[10px] text-muted-foreground mt-1 uppercase tracking-normal">Thu, Oct 24</span>
        </div>
        <Button variant="ghost" size="icon" className="-mr-2 rounded-full" aria-label="Next day">
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>
    </nav>
  )
}