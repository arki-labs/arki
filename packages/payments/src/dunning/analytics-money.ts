/**
 * Money in the dunning analytics rows
 *
 * A row of `dunning_campaign_analytics` holds one currency: its `*_minor`
 * columns are whole minor units of the row's `currency`. A campaign can recover
 * payments in several currencies, so a day gets one row per currency, and a
 * total over rows is a `MoneyBag`: it keeps each currency apart and never adds
 * two of them.
 */

import { MoneyBag } from '@arki/money/bag';

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

/** Sums `(currency, minor units)` pairs into one bag, a balance per currency. */
export function sumMinorByCurrency(rows: readonly { currency: string; units: number | string }[]): MoneyBag {
  return MoneyBag.of(...rows.map(row => fromMinorColumn(row.units, row.currency)));
}
