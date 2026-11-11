/**
 * Money in the dunning analytics rows
 *
 * A row of `dunning_campaign_analytics` holds one currency: its `*_minor`
 * columns are whole minor units of the row's `currency`. A campaign can recover
 * payments in several currencies, so a day gets one row per currency, and a
 * total over rows is a `MoneyBag`: it keeps each currency apart and never adds
 * two of them.
 */

import type { SchemaFailure } from '@arki/failure';
import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';
import { MoneyBag } from '@arki/money/bag';
import { currencyCodeSchema } from '@arki/money/zod';
import { parse } from '@arki/schema';

import type { DunningCampaignId } from './primitives.js';
import { fromMinorColumn } from '../core/money.js';

/**
 * Counters with no payment behind them (customers reached, messages sent) have
 * no currency of their own. They go to this row, the payments tables' column
 * default, with zero money.
 */
export const DEFAULT_ANALYTICS_CURRENCY = 'USD';

/** The row id of one campaign, day (`YYYY-MM-DD`) and currency. */
export function analyticsRowId(campaignId: DunningCampaignId, day: string, currency: string): string {
  return `${campaignId}-${day}-${currency.toUpperCase()}`;
}

/** One analytics row's money: an ISO 4217 code in any case, and whole minor units (a safe integer, or the digits of one). */
const minorRowSchema = z.object({
  currency: z
    .string()
    .transform(code => code.toUpperCase())
    .pipe(currencyCodeSchema),
  units: z.union([
    z.number().int(),
    z
      .string()
      .regex(/^-?\d{1,16}$/)
      .refine(digits => Math.abs(Number(digits)) <= Number.MAX_SAFE_INTEGER, 'Units must be a safe integer'),
  ]),
});

/**
 * Sums `(currency, minor units)` pairs into one bag, a balance per currency. It folds row by row
 * instead of spreading the rows into one call, so any number of rows fits (a spread past about
 * 150,000 arguments throws `RangeError`); the rows are a stored result set, not a caller batch, so
 * they have no `MAX_BATCH_ITEMS` cap. A row whose currency is not an ISO 4217 code, or whose units are
 * not a safe whole number (a fraction, `NaN`, past 2^53 - 1, text that is not digits), returns
 * `schema.invalid_input` and sums nothing.
 */
export function sumMinorByCurrency(
  rows: readonly { currency: string; units: number | string }[],
): MoneyBag | SchemaFailure {
  const checked = parse(z.array(minorRowSchema), rows);
  if (isFailure(checked)) return checked;
  return rows.reduce((bag, row) => bag.plus(fromMinorColumn(row.units, row.currency)), MoneyBag.of());
}
