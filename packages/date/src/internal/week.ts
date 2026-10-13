import type { PlainDate, WeekRules } from '../types.js';

/** The first day of the week containing `date` under `rules`. */
export function startOfWeekDate(date: PlainDate, rules: WeekRules): PlainDate {
  const back = (date.dayOfWeek - rules.startsOn + 7) % 7;
  return back === 0 ? date : date.subtract({ days: back });
}
