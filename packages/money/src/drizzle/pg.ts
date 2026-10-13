/**
 * Drizzle columns for Postgres that read and write `Money`. Optional: needs
 * `drizzle-orm` 1.x installed.
 *
 * - `moneyMinor(name, { currency })` — a `bigint` column of minor units for one
 *   fixed currency ↔ `Money<C>`. Best for sums in SQL.
 * - `moneyDecimal(name, { currency, precision, scale })` — a `numeric` column ↔
 *   `Money<C>`. Readable in SQL tools; holds more decimals than the currency.
 * - `moneyJson(name)` — a `jsonb` column of `{ amount, currency }` ↔ `Money`
 *   in any currency. For prices that vary by row.
 *
 * The columns declare text codecs, so every driver (node-postgres,
 * postgres.js, PGlite, Bun SQL) hands back text and no value passes through a
 * float. Writing a `Money` in another currency, or with more decimals than the
 * column holds, throws instead of storing a wrong value.
 */

import { customType } from 'drizzle-orm/pg-core';

import type { Money } from '../money.js';
import type { MoneyDecimalConfig, MoneyJsonConfig, MoneyMinorConfig } from './config.js';
import {
  decimalFromDriver,
  decimalToDriver,
  jsonFromDriver,
  jsonToDriver,
  minorFromDriver,
  minorToDriver,
} from '../internal/columns.js';
import { resolveColumn } from './config.js';

export type { MoneyDecimalConfig, MoneyJsonConfig, MoneyMinorConfig } from './config.js';

/** `bigint` column ↔ `Money<C>` in one fixed currency. */
export function moneyMinor<const C extends string>(name: string, config: MoneyMinorConfig<C>) {
  const { currency, scale } = resolveColumn(config, 'moneyMinor');
  return customType<{ data: Money<C>; driverData: string; config: MoneyMinorConfig<C> }>({
    dataType: () => 'bigint',
    codec: 'bigint:string',
    toDriver: value => String(minorToDriver(value, currency, scale)),
    fromDriver: value => minorFromDriver(value, currency, scale),
  })(name, config);
}

/** `numeric(precision, scale)` column ↔ `Money<C>` in one fixed currency. */
export function moneyDecimal<const C extends string>(name: string, config: MoneyDecimalConfig<C>) {
  const { currency, scale } = resolveColumn(config, 'moneyDecimal');
  const precision = config.precision ?? 19;
  return customType<{ data: Money<C>; driverData: string; config: MoneyDecimalConfig<C> }>({
    dataType: () => `numeric(${precision}, ${scale})`,
    codec: 'numeric',
    toDriver: value => decimalToDriver(value, currency, scale),
    fromDriver: value => decimalFromDriver(value, currency, scale),
  })(name, config);
}

/** `jsonb` column of `{ amount, currency }` ↔ `Money` in any currency. */
export function moneyJson(name: string, config: MoneyJsonConfig = {}) {
  return customType<{ data: Money; driverData: string; config: MoneyJsonConfig }>({
    dataType: () => 'jsonb',
    toDriver: jsonToDriver,
    fromDriver: value => jsonFromDriver(value, config.currencies),
  })(name, config);
}
