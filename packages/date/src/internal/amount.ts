import type { Amount, Duration } from '../types.js';
import { isDuration, Temporal } from '../types.js';

/** Expand an `Amount` (which may carry `quarters`) into a Temporal `Duration`. */
export function toDuration(amount: Amount | Duration): Duration {
  if (isDuration(amount)) return amount;
  const { quarters = 0, months = 0, ...rest } = amount;
  if (!Number.isInteger(quarters)) throw new RangeError(`quarters must be an integer, received ${String(quarters)}`);
  return Temporal.Duration.from({ ...rest, months: months + quarters * 3 });
}
