import { PGlite } from '@electric-sql/pglite';
import { eq, gte, sql } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant as toInstant, plainDate as toPlainDate } from '@arki/date/core';

import { instant, instantFromDriver, plainDate, plainDateFromDriver } from './temporal.js';

describe('driver text parsing', () => {
  it('reads every offset form Postgres prints for timestamptz', () => {
    expect(instantFromDriver('2026-05-20 10:30:00+03').toString()).toBe('2026-05-20T07:30:00Z');
    expect(instantFromDriver('2026-05-20 10:30:00.123456+05:30').toString()).toBe('2026-05-20T05:00:00.123456Z');
    // Historic local mean time has a seconds offset.
    expect(instantFromDriver('1890-01-01 00:00:00+01:44:24').toString()).toBe('1889-12-31T22:15:36Z');
    // Relational queries return JSON with a `T` separator.
    expect(instantFromDriver('2026-05-20T07:30:00+00:00').toString()).toBe('2026-05-20T07:30:00Z');
  });

  it('reads timestamp-without-zone text as UTC, the way Drizzle does', () => {
    expect(instantFromDriver('2026-05-20 07:30:00.25').toString()).toBe('2026-05-20T07:30:00.25Z');
  });

  it('refuses values Temporal cannot hold instead of guessing', () => {
    expect(() => instantFromDriver('infinity')).toThrow(/cannot read timestamp "infinity"/);
    expect(() => plainDateFromDriver('0044-03-15 BC')).toThrow(/cannot read date/);
  });
});

// A real Postgres engine: the columns must round-trip through the actual wire format, defaults and filters.
const events = pgTable('temporal_events', {
  id: text('id').primaryKey(),
  day: plainDate('day').notNull(),
  at: instant('at').notNull(),
  legacyAt: instant('legacy_at', { withTimezone: false }).notNull(),
  createdAt: instant('created_at')
    .default(sql`now()`)
    .notNull(),
  // A built-in column on the same table, to prove the custom ones leave it alone.
  builtIn: timestamp('built_in', { withTimezone: true }).notNull(),
});

describe('columns on PGlite', () => {
  const client = new PGlite();
  const db = drizzle({ client });

  beforeAll(async () => {
    // A non-UTC session zone: timestamptz text then carries +03/+02 offsets, exercising the parser.
    await db.execute(sql`SET TIME ZONE 'Europe/Bucharest'`);
    await db.execute(sql`
      CREATE TABLE temporal_events (
        id text PRIMARY KEY,
        day date NOT NULL,
        at timestamp with time zone NOT NULL,
        legacy_at timestamp NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        built_in timestamp with time zone NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await client.close();
  });

  it('round-trips dates and instants exactly', async () => {
    const at = toInstant('2026-03-29T00:30:00.123456Z'); // 02:30 → 03:30 across the Bucharest DST jump
    await db.insert(events).values({
      id: 'a',
      day: toPlainDate('2026-03-29'),
      at,
      legacyAt: at,
      builtIn: new Date('2026-03-29T00:30:00Z'),
    });
    const [row] = await db.select().from(events);
    expect(row?.day.toString()).toBe('2026-03-29');
    expect(row?.at.equals(at)).toBe(true);
    expect(row?.legacyAt.equals(at)).toBe(true);
    expect(row?.createdAt).toBeInstanceOf(toInstant('2026-01-01T00:00:00Z').constructor);
    expect(row?.builtIn).toBeInstanceOf(Date);
  });

  it('stores the UTC wall clock in a timestamp-without-zone column', async () => {
    const result = await db.execute<{ text: string }>(sql`SELECT legacy_at::text AS text FROM temporal_events`);
    expect(result.rows[0]?.text).toBe('2026-03-29 00:30:00.123456');
  });

  it('binds Temporal values through eq and gte, as repositories do', async () => {
    const at = toInstant('2026-03-29T00:30:00.123456Z');
    expect(await db.select({ id: events.id }).from(events).where(eq(events.at, at))).toEqual([{ id: 'a' }]);
    expect(await db.select({ id: events.id }).from(events).where(gte(events.legacyAt, at))).toEqual([{ id: 'a' }]);
    expect(
      await db
        .select({ id: events.id })
        .from(events)
        .where(gte(events.legacyAt, toInstant('2026-03-29T00:30:01Z'))),
    ).toEqual([]);
    expect(
      await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.day, toPlainDate('2026-03-29'))),
    ).toEqual([{ id: 'a' }]);
  });
});
