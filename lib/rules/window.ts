import type { WindowRuleConfig } from "@/lib/rules/types"

/**
 * Whether a `startMin`-to-`startMin + durationMin` block stays entirely
 * inside a Window Rule's bounds.
 *
 * Strict and Flexible windows are both hard containers here — a Flexible
 * window only relaxes *where inside the window* a (typically shorter) block
 * floats, never whether it may start or end outside the window itself. A
 * block can never start outside the bounds, and must stay within them the
 * whole time.
 *
 * Spanning-midnight windows (`endMin <= startMin`) are excluded — their
 * bounds wrap past 24:00, which callers reasoning in a single day's minutes
 * can't evaluate here.
 */
export function windowContains(window: WindowRuleConfig, startMin: number, durationMin: number): boolean {
  if (window.endMin <= window.startMin) return false
  return startMin >= window.startMin && startMin + durationMin <= window.endMin
}
