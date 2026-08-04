/** The `allowed_days` encoding used by `activityTable` and the daily generator. */
export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const

export type Weekday = (typeof WEEKDAYS)[number]

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
}

export function weekdayLabel(day: Weekday): string {
  return WEEKDAY_LABELS[day]
}

/** The weekday for a given date (defaults to now), in the `allowed_days` encoding. */
export function weekdayOf(date: Date = new Date()): Weekday {
  return WEEKDAYS[(date.getDay() + 6) % 7]
}
