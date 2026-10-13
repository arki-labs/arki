/** Column options shared by every SQL dialect. */

import type { Currency, CurrencyLike } from '../currency.js';
import { toCurrency } from '../currency.js';
import { InvalidArgumentError } from '../errors.js';
import { MAX_SCALE } from '../internal/units.js';

export type MoneyMinorConfig<C extends string> = {
  currency: CurrencyLike<C>;
  /** Decimals the stored integer carries. Defaults to the currency's. */
  scale?: number;
};

export type MoneyDecimalConfig<C extends string> = {
  currency: CurrencyLike<C>;
  /** Total digits, as in `numeric(precision, scale)`. Default 19. Ignored by SQLite. */
  precision?: number;
  /** Decimals stored. Defaults to the currency's. */
  scale?: number;
};

export type MoneyJsonConfig = {
  /** Custom currencies to resolve by code on read. */
  currencies?: readonly Currency[];
};

/** Validates a column config once, when the table is defined. */
export function resolveColumn<C extends string>(
  config: { currency: CurrencyLike<C>; scale?: number } | undefined,
  column: string,
): { currency: Currency<C>; scale: number } {
  if (config === undefined) throw new InvalidArgumentError(`${column} needs a config with a currency`);
  const currency = toCurrency(config.currency);
  const scale = config.scale ?? currency.scale;
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new InvalidArgumentError(`${column}: scale must be a whole number from 0 to ${MAX_SCALE}, got ${scale}`);
  }
  return { currency, scale };
}
