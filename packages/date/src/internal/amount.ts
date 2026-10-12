import type { Amount, Duration } from '../types.js';
import { isDuration, Temporal } from '../types.js';

/**
 * What Temporal's `add`/`subtract` accept. A plain field object is passed
 * straight through — building a `Temporal.Duration` first costs more than the
 * arithmetic itself on the polyfill — so this only expands `quarters` (which
 * Temporal has no field for) into months.
 */
const DURATION_FIELDS = [
  'years',
  'months',
  'weeks',
  'days',
  'hours',
  'minutes',
  'seconds',
  'milliseconds',
  'microseconds',
  'nanoseconds',
] as const;

export type DurationFields = Partial<Record<(typeof DURATION_FIELDS)[number], number>>;
export type DurationInput = Duration | DurationFields;

export function toDurationInput(amount: Amount | Duration): DurationInput {
  if (isDuration(amount)) return amount;
  if (amount.quarters === undefined) return amount;
  const { quarters, months = 0, ...rest } = amount;
  if (!Number.isInteger(quarters)) throw new RangeError(`quarters must be an integer, received ${String(quarters)}`);
  return { ...rest, months: months + quarters * 3 };
}

/** The same amount with every field negated (`-0` normalized to `0`). */
export function negateDurationInput(input: DurationInput): DurationInput {
  if (isDuration(input)) return input.negated();
  const negated: DurationFields = {};
  for (const field of DURATION_FIELDS) {
    const value = input[field];
    if (value !== undefined) negated[field] = value === 0 ? 0 : -value;
  }
  return negated;
}

/** Expand an `Amount` (which may carry `quarters`) into a real `Temporal.Duration`. */
export function toDuration(amount: Amount | Duration): Duration {
  const input = toDurationInput(amount);
  return isDuration(input) ? input : Temporal.Duration.from(input);
}
