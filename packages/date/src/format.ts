import { format } from 'date-fns';

export function toHumanReadableDate(date: Date) {
  return format(date, 'LLL dd, y');
}

export { format } from 'date-fns';
