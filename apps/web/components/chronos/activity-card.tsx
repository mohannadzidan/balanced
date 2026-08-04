import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface ActivityCardProps {
  icon?: React.ReactNode
  title: string
  subtitle?: string
  badge?: {
    label: string
    variant?: "default" | "secondary" | "destructive" | "outline" | "ghost"
  }
  className?: string
  children?: React.ReactNode
}

export function ActivityCard({
  icon,
  title,
  subtitle,
  badge,
  className,
  children,
}: ActivityCardProps) {
  return (
    <div
      className={cn(
        "shadow-whisper rounded-[12px] border border-border bg-card p-4",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold tracking-[-0.2px] text-foreground">
            {title}
          </span>
        </div>
        {badge && (
          <Badge
            variant={badge.variant}
            className="px-1.5 py-0.5 font-mono text-[10px]"
          >
            {badge.label}
          </Badge>
        )}
      </div>
      {subtitle && (
        <div className="mt-1 ml-4 text-xs text-muted-foreground">
          {subtitle}
        </div>
      )}
      {children}
    </div>
  )
}
