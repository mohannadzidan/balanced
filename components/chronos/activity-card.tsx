import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface ActivityCardProps {
  icon?: React.ReactNode
  title: string
  subtitle?: string
  badge?: { label: string; variant?: "default" | "secondary" | "destructive" | "outline" | "ghost" }
  className?: string
  children?: React.ReactNode
}

export function ActivityCard({ icon, title, subtitle, badge, className, children }: ActivityCardProps) {
  return (
    <div className={cn("bg-card border border-border rounded-[12px] p-4 shadow-whisper", className)}>
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-foreground text-sm font-semibold tracking-[-0.2px]">{title}</span>
        </div>
        {badge && <Badge variant={badge.variant} className="font-mono text-[10px] px-1.5 py-0.5">{badge.label}</Badge>}
      </div>
      {subtitle && <div className="text-xs text-muted-foreground mt-1 ml-4">{subtitle}</div>}
      {children}
    </div>
  )
}