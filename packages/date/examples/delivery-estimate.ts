import type { PlainDate } from '../src/types.js';
import { addBusinessDays, businessCalendar, nextBusinessDay } from '../src/business.js';
import { toPlainDate, zoned } from '../src/core.js';
import { format } from '../src/format.js';

// #region delivery-estimate
const romania = businessCalendar({ holidays: ['2026-12-01', '2026-12-25'] });
const cutOffHour = 15;

/**
 * The day an order arrives: `days` business days after it ships.
 * An order placed at or after 15:00 in the shop's zone ships on the next business day.
 */
export function estimateDelivery(orderedAt: string, shopZone: string, days: number): PlainDate {
  const placed = zoned(orderedAt, shopZone);
  const day = toPlainDate(placed);
  const shipsOn = placed.hour >= cutOffHour ? nextBusinessDay(day, romania) : day;
  return addBusinessDays(shipsOn, days, romania);
}

/** The same day as text for an order confirmation, for example "Thursday, December 3rd". */
export function describeDelivery(orderedAt: string, shopZone: string, days: number): string {
  return format(estimateDelivery(orderedAt, shopZone, days), 'EEEE, MMMM do');
}
// #endregion
