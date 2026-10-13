import { PGlite } from '@electric-sql/pglite';
import { pgTable, serial } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { moneyDecimal, moneyJson, moneyMinor } from './drizzle/pg.js';
import { Currency, CurrencyMismatchError, Money, money, RoundingNecessaryError } from './index.js';
import { anyMoneySchema, currencyCodeSchema, moneyInputSchema, moneySchema } from './zod.js';

describe('zod', () => {
  it('turns JSON into typed Money and reports problems as issues', () => {
    const schema = moneySchema('EUR', { min: money(0, 'EUR') });
    const parsed = schema.parse({ amount: '19.99', currency: 'EUR' });
    expectTypeOf(parsed).toEqualTypeOf<Money<'EUR'>>();
    expect(parsed.toString()).toBe('19.99 EUR');

    const wrongCurrency = schema.safeParse({ amount: '1', currency: 'USD' });
    expect(wrongCurrency.success).toBe(false);
    expect(wrongCurrency.error?.issues[0]?.path).toEqual(['currency']);
    expect(schema.safeParse({ amount: '1.005', currency: 'EUR' }).success).toBe(false);
    expect(schema.safeParse({ amount: '-1', currency: 'EUR' }).error?.issues[0]?.message).toBe(
      'Must be at least 0.00 EUR',
    );
    expect(schema.safeParse({ amount: 19.99, currency: 'EUR' }).success).toBe(false);
    expect(moneySchema('EUR', { rounding: 'halfEven' }).parse({ amount: '1.005', currency: 'EUR' }).toString()).toBe(
      '1.00 EUR',
    );
  });

  it('accepts any known currency with anyMoneySchema', () => {
    const btc = Currency.custom({ code: 'BTC', scale: 8 });
    const schema = anyMoneySchema({ currencies: [btc] });
    expect(schema.parse({ amount: '1.5', currency: 'USD' }).toString()).toBe('1.50 USD');
    expect(schema.parse({ amount: '0.1', currency: 'BTC' }).toString()).toBe('0.10000000 BTC');
    expect(schema.safeParse({ amount: '1', currency: 'ZZZ' }).error?.issues[0]?.path).toEqual(['currency']);
  });

  it('parses form text with the locale rules', () => {
    const field = moneyInputSchema('EUR', { locale: 'de-DE', max: money(10_000, 'EUR') });
    expect(field.parse('1.234,56 €').toString()).toBe('1234.56 EUR');
    expect(field.safeParse('1,23,4').success).toBe(false);
    expect(field.safeParse('20.000 €').success).toBe(false);
    expect(currencyCodeSchema.safeParse('EUR').success).toBe(true);
    expect(currencyCodeSchema.safeParse('ZZZ').success).toBe(false);
  });
});

describe('drizzle on Postgres (PGlite)', () => {
  const btc = Currency.custom({ code: 'BTC', scale: 8 });
  const prices = pgTable('prices', {
    id: serial('id').primaryKey(),
    total: moneyMinor('total', { currency: 'EUR' }).notNull(),
    unit: moneyDecimal('unit', { currency: 'EUR', precision: 30, scale: 4 }).notNull(),
    jpy: moneyMinor('jpy', { currency: 'JPY' }).notNull(),
    flexible: moneyJson('flexible', { currencies: [btc] }).notNull(),
  });
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = new PGlite('memory://');
    await client.waitReady;
    db = drizzle({ client });
    await client.exec(
      'create table prices (id serial primary key, total bigint not null, unit numeric(30, 4) not null, jpy bigint not null, flexible jsonb not null)',
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it('round-trips Money exactly, including values past 2^53', async () => {
    const huge = Money.fromMinor(2n ** 62n + 7n, 'EUR');
    await db.insert(prices).values([
      {
        total: money('19.99', 'EUR'),
        unit: money('0.1234', 'EUR', { scale: 4 }),
        jpy: money(500, 'JPY'),
        flexible: money('0.5', btc),
      },
      {
        total: huge,
        unit: money('123456789012345678.9999', 'EUR', { scale: 4 }),
        jpy: money(0, 'JPY'),
        flexible: money('-3', 'USD'),
      },
    ]);
    const rows = await db.select().from(prices).orderBy(prices.id);
    expectTypeOf<(typeof prices.$inferSelect)['total']>().toEqualTypeOf<Money<'EUR'>>();
    expect(rows.map(row => [String(row.total), String(row.unit), String(row.jpy), String(row.flexible)])).toEqual([
      ['19.99 EUR', '0.1234 EUR', '500 JPY', '0.50000000 BTC'],
      [huge.toString(), '123456789012345678.9999 EUR', '0 JPY', '-3.00 USD'],
    ]);
    const stored = await client.query<{ total: string; unit: string }>(
      'select total::text, unit::text from prices order by id',
    );
    expect(stored.rows[0]).toEqual({ total: '1999', unit: '0.1234' });
  });

  it('refuses to store a wrong currency or a value that would need rounding', async () => {
    const row = { unit: money(1, 'EUR'), jpy: money(1, 'JPY'), flexible: money(1, 'EUR') };
    // @ts-expect-error -- the column holds EUR
    await expect(db.insert(prices).values({ ...row, total: money(1, 'USD') })).rejects.toThrow(CurrencyMismatchError);
    await expect(db.insert(prices).values({ ...row, total: money('0.001', 'EUR', { scale: 3 }) })).rejects.toThrow(
      RoundingNecessaryError,
    );
  });
});
