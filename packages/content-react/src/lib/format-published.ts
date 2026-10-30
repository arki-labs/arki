import { format } from '@arki/date/format';

/**
 * Formats a publish date for display. A value that is not a valid date (a bad front-matter date)
 * shows as written instead of throwing a `RangeError` while the page renders.
 */
export function formatPublished(value: Date | string | number, pattern: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : format(date, pattern);
}
