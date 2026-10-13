/**
 * Drizzle columns for SQLite (libSQL, Turso, better-sqlite3, Bun SQLite,
 * Cloudflare D1, Expo SQLite) that read and write `Money`. Optional: needs
 * `drizzle-orm` 1.x installed.
 *
 * - `moneyMinor(name, { currency })` — an `integer` column of minor units ↔ `Money<C>`.
 * - `moneyDecimal(name, { currency, scale })` — a `text` column of exact decimal
 *   text ↔ `Money<C>`. SQLite has no exact decimal type, so text keeps every digit.
 * - `moneyJson(name)` — a `text` column of `{ amount, currency }` JSON ↔ `Money`.
 *
 * SQLite integers are 64-bit, but most drivers return JavaScript numbers.
 * Amounts up to 2^53 minor units are exact. A bigger stored amount throws on
 * read instead of becoming a wrong value; to read those, switch the driver to
 * big integers (libSQL `intMode: 'bigint'`, better-sqlite3 `safeIntegers()`).
 */

import { customType } from 'drizzle-orm/sqlite-core';

import type { IntegerDriverValue } from '../internal/columns.js';
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

/** `integer` column ↔ `Money<C>` in one fixed currency. Writes a `bigint` past 2^53. */
export function moneyMinor<const C extends string>(name: string, config: MoneyMinorConfig<C>) {
  const { currency, scale } = resolveColumn(config, 'moneyMinor');
  return customType<{ data: Money<C>; driverData: IntegerDriverValue; config: MoneyMinorConfig<C> }>({
    dataType: () => 'integer',
    toDriver: value => minorToDriver(value, currency, scale),
    fromDriver: value => minorFromDriver(value, currency, scale),
  })(name, config);
}

/** `text` column of exact decimal text ↔ `Money<C>` in one fixed currency. */
export function moneyDecimal<const C extends string>(name: string, config: MoneyDecimalConfig<C>) {
  const { currency, scale } = resolveColumn(config, 'moneyDecimal');
  return customType<{ data: Money<C>; driverData: string; config: MoneyDecimalConfig<C> }>({
    dataType: () => 'text',
    toDriver: value => decimalToDriver(value, currency, scale),
    fromDriver: value => decimalFromDriver(value, currency, scale),
  })(name, config);
}

/** `text` column of `{ amount, currency }` JSON ↔ `Money` in any currency. */
export function moneyJson(name: string, config: MoneyJsonConfig = {}) {
  return customType<{ data: Money; driverData: string; config: MoneyJsonConfig }>({
    dataType: () => 'text',
    toDriver: jsonToDriver,
    fromDriver: value => jsonFromDriver(value, config.currencies),
  })(name, config);
}
