/// <reference types="node" />
import type { Client } from '@libsql/client';
import type { Connection } from 'mysql2/promise';
import { createClient } from '@libsql/client';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import { int, mysqlTable } from 'drizzle-orm/mysql-core';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { createConnection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import * as mysql from './drizzle/mysql.js';
import * as sqlite from './drizzle/sqlite.js';
import { Currency, CurrencyMismatchError, Money, money, NumericRangeError, RoundingNecessaryError } from './index.js';
import { minorFromDriver } from './internal/columns.js';

const btc = Currency.custom({ code: 'BTC', scale: 8 });
const huge = Money.fromMinor(2n ** 62n + 7n, 'EUR');

describe('drizzle on SQLite (libSQL)', () => {
  const prices = sqliteTable('prices', {
    id: integer('id').primaryKey(),
    total: sqlite.moneyMinor('total', { currency: 'EUR' }).notNull(),
    unit: sqlite.moneyDecimal('unit', { currency: 'EUR', scale: 4 }).notNull(),
    flexible: sqlite.moneyJson('flexible', { currencies: [btc] }).notNull(),
  });
  const ddl =
    'create table prices (id integer primary key, total integer not null, unit text not null, flexible text not null)';
  let numbers: Client;
  let bigints: Client;

  beforeAll(async () => {
    numbers = createClient({ url: ':memory:' });
    bigints = createClient({ url: ':memory:', intMode: 'bigint' });
    await numbers.execute(ddl);
    await bigints.execute(ddl);
  });

  afterAll(() => {
    numbers.close();
    bigints.close();
  });

  it('round-trips Money exactly', async () => {
    const db = drizzleLibsql({ client: numbers });
    await db.insert(prices).values({
      id: 1,
      total: money('19.99', 'EUR'),
      unit: money('123456789012345678.9999', 'EUR', { scale: 4 }),
      flexible: money('0.5', btc),
    });
    const [row] = await db.select().from(prices);
    expectTypeOf<(typeof prices.$inferSelect)['total']>().toEqualTypeOf<Money<'EUR'>>();
    expect([String(row?.total), String(row?.unit), String(row?.flexible)]).toEqual([
      '19.99 EUR',
      '123456789012345678.9999 EUR',
      '0.50000000 BTC',
    ]);
    const raw = await numbers.execute('select typeof(total) as kind, total from prices');
    expect(raw.rows[0]).toMatchObject({ kind: 'integer', total: 1999 });
  });

  it('stores amounts past 2^53 and reads them with a big-integer driver, never as a rounded number', async () => {
    const row = { id: 2, total: huge, unit: money(1, 'EUR', { scale: 4 }), flexible: money(1, 'USD') };
    await drizzleLibsql({ client: bigints }).insert(prices).values(row);
    const [back] = await drizzleLibsql({ client: bigints }).select().from(prices);
    expect(back?.total.eq(huge)).toBe(true);

    await drizzleLibsql({ client: numbers }).insert(prices).values(row);
    // In number mode the driver itself refuses the value; it never reaches us rounded.
    await expect(drizzleLibsql({ client: numbers }).select().from(prices)).rejects.toThrow();
  });

  it('refuses a wrong currency or a value that would need rounding', async () => {
    const db = drizzleLibsql({ client: bigints });
    const row = { id: 3, unit: money(1, 'EUR'), flexible: money(1, 'EUR') };
    // @ts-expect-error -- the column holds EUR
    await expect(db.insert(prices).values({ ...row, total: money(1, 'USD') })).rejects.toThrow(CurrencyMismatchError);
    await expect(db.insert(prices).values({ ...row, total: money('0.001', 'EUR', { scale: 3 }) })).rejects.toThrow(
      RoundingNecessaryError,
    );
  });

  it('rejects an integer a driver already rounded', () => {
    // better-sqlite3 without safeIntegers() hands back 2^60 + 1 as the double 2^60.
    expect(() => minorFromDriver(2 ** 60, Currency.of('EUR'), 2)).toThrow(NumericRangeError);
    expect(minorFromDriver('1999', Currency.of('EUR'), 2).toString()).toBe('19.99 EUR');
    expect(minorFromDriver(1999n, Currency.of('EUR'), 2).toString()).toBe('19.99 EUR');
  });
});

// eslint-disable-next-line turbo/no-undeclared-env-vars -- opt-in test switch, not a build input
const mysqlUrl = process.env.MONEY_TEST_MYSQL_URL;
if (mysqlUrl === undefined) {
  console.warn('MySQL money columns NOT tested: set MONEY_TEST_MYSQL_URL (e.g. mysql://root:pw@127.0.0.1:3306/money)');
}

describe.skipIf(mysqlUrl === undefined)('drizzle on MySQL (mysql2)', () => {
  const prices = mysqlTable('prices', {
    id: int('id').primaryKey(),
    total: mysql.moneyMinor('total', { currency: 'EUR' }).notNull(),
    unit: mysql.moneyDecimal('unit', { currency: 'EUR', precision: 30, scale: 4 }).notNull(),
    flexible: mysql.moneyJson('flexible', { currencies: [btc] }).notNull(),
  });
  let connection: Connection;

  beforeAll(async () => {
    connection = await createConnection(mysqlUrl ?? '');
    await connection.query('drop table if exists prices');
    await connection.query(
      'create table prices (id int primary key, total bigint not null, unit decimal(30, 4) not null, flexible json not null)',
    );
  });

  afterAll(async () => {
    await connection.end();
  });

  it('round-trips Money exactly, including values past 2^53', async () => {
    const db = drizzleMysql({ client: connection });
    await db.insert(prices).values([
      { id: 1, total: money('19.99', 'EUR'), unit: money('0.1234', 'EUR', { scale: 4 }), flexible: money('0.5', btc) },
      {
        id: 2,
        total: huge,
        unit: money('12345678901234567890.9999', 'EUR', { scale: 4 }),
        flexible: money('-3', 'USD'),
      },
    ]);
    const rows = await db.select().from(prices).orderBy(prices.id);
    expect(rows.map(row => [String(row.total), String(row.unit), String(row.flexible)])).toEqual([
      ['19.99 EUR', '0.1234 EUR', '0.50000000 BTC'],
      [huge.toString(), '12345678901234567890.9999 EUR', '-3.00 USD'],
    ]);
  });

  it('refuses a wrong currency', async () => {
    const db = drizzleMysql({ client: connection });
    const row = { id: 3, unit: money(1, 'EUR'), flexible: money(1, 'EUR') };
    // @ts-expect-error -- the column holds EUR
    await expect(db.insert(prices).values({ ...row, total: money(1, 'USD') })).rejects.toThrow(CurrencyMismatchError);
  });
});
