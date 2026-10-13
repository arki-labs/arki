/**
 * Drizzle columns for MySQL and MariaDB that read and write `Money`.
 * Optional: needs `drizzle-orm` 1.x installed.
 *
 * - `moneyMinor(name, { currency })` — a `bigint` column of minor units ↔ `Money<C>`.
 * - `moneyDecimal(name, { currency, precision, scale })` — a `decimal` column ↔ `Money<C>`.
 * - `moneyJson(name)` — a `json` column of `{ amount, currency }` ↔ `Money` in any currency.
 *
 * `mysql2` returns `DECIMAL` as text and `JSON` as parsed objects by default,
 * and the `bigint` column declares a text codec, so no value passes through a
 * float. If a driver still returns a big integer as an unsafe `number`, reading
 * it throws instead of returning a wrong amount.
 */

import { customType } from 'drizzle-orm/mysql-core';

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

/** `bigint` column ↔ `Money<C>` in one fixed currency. */
export function moneyMinor<const C extends string>(name: string, config: MoneyMinorConfig<C>) {
  const { currency, scale } = resolveColumn(config, 'moneyMinor');
  return customType<{ data: Money<C>; driverData: IntegerDriverValue; config: MoneyMinorConfig<C> }>({
    dataType: () => 'bigint',
    codec: 'bigint:string',
    toDriver: value => String(minorToDriver(value, currency, scale)),
    fromDriver: value => minorFromDriver(value, currency, scale),
  })(name, config);
}

/** `decimal(precision, scale)` column ↔ `Money<C>` in one fixed currency. */
export function moneyDecimal<const C extends string>(name: string, config: MoneyDecimalConfig<C>) {
  const { currency, scale } = resolveColumn(config, 'moneyDecimal');
  const precision = config.precision ?? 19;
  return customType<{ data: Money<C>; driverData: string | number; config: MoneyDecimalConfig<C> }>({
    dataType: () => `decimal(${precision}, ${scale})`,
    toDriver: value => decimalToDriver(value, currency, scale),
    fromDriver: value => decimalFromDriver(value, currency, scale),
  })(name, config);
}

/** `json` column of `{ amount, currency }` ↔ `Money` in any currency. */
export function moneyJson(name: string, config: MoneyJsonConfig = {}) {
  return customType<{ data: Money; driverData: unknown; config: MoneyJsonConfig }>({
    dataType: () => 'json',
    toDriver: jsonToDriver,
    fromDriver: value => jsonFromDriver(value, config.currencies),
  })(name, config);
}
