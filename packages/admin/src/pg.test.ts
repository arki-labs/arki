/**
 * T(admin-pg-store) — the Postgres store for apps without a KV, on a real (in-memory) Postgres. Why it
 * matters: a nonce taken twice is a replayed signed request, and two app instances racing for one nonce
 * must never both win.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq, sql } from 'drizzle-orm';
import { pgSchema } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { foremanStoreTable, pgForemanStore } from './pg.ts';
import { storedReceiptSchema } from './receipts.ts';

const table = foremanStoreTable();
const clients: PGlite[] = [];

async function openStore() {
  const client = new PGlite('memory://');
  clients.push(client);
  await client.waitReady;
  const db = drizzle({ client });
  const { apply } = await pushSchema({ table }, db);
  await apply();
  return { db, store: pgForemanStore({ db, table }) };
}

afterAll(async () => {
  await Promise.all(clients.map(async client => client.close()));
});

describe('T(admin-pg-store) pgForemanStore', () => {
  it('works inside an app schema, where apps with a schemaFilter keep their tables', async () => {
    const client = new PGlite('memory://');
    clients.push(client);
    const shop = pgSchema('shop');
    const scoped = foremanStoreTable({ schema: shop });
    const db = drizzle({ client });
    const { apply } = await pushSchema({ shop, scoped }, db);
    await apply();
    const store = pgForemanStore({ db, table: scoped });
    expect(await store.setIfNotExists('nonce:1', 1, 300)).toBe(true);
    const rows = await db.execute<{ table_schema: string }>(
      sql`select table_schema from information_schema.tables where table_name = 'foreman_store'`,
    );
    expect(rows.rows.map(row => row.table_schema)).toEqual(['shop']);
  });

  it('takes a nonce once, and again only after it expired', async () => {
    const { db, store } = await openStore();
    expect(await store.setIfNotExists('nonce:1', 1, 300)).toBe(true);
    expect(await store.setIfNotExists('nonce:1', 1, 300)).toBe(false);
    await db
      .update(table)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(table.key, 'nonce:1'));
    expect(await store.setIfNotExists('nonce:1', 1, 300)).toBe(true);
  });

  it('of two concurrent takes of one nonce exactly one wins', async () => {
    const { store } = await openStore();
    const results = await Promise.all([
      store.setIfNotExists('nonce:race', 1, 300),
      store.setIfNotExists('nonce:race', 1, 300),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('stores, overwrites and expires a value', async () => {
    const { db, store } = await openStore();
    const pending = {
      status: 'pending',
      executionId: 'exe_1',
      actionId: 'a.b',
      claimedAt: '2026-10-23T00:00:00.000Z',
    } as const;
    const applied = {
      ...pending,
      status: 'applied',
      appliedAt: '2026-10-23T00:00:01.000Z',
      result: { ok: true },
    } as const;
    orThrow(await store.set('receipt:1', pending, 60));
    expect(await store.get('receipt:1', storedReceiptSchema)).toEqual(pending);
    orThrow(await store.set('receipt:1', applied, 60));
    expect(await store.get('receipt:1', storedReceiptSchema)).toEqual(applied);
    await db
      .update(table)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(table.key, 'receipt:1'));
    expect(await store.get('receipt:1', storedReceiptSchema)).toBeUndefined();
  });

  it('deletes expired rows when it takes a nonce, so the table stays small', async () => {
    const { db, store } = await openStore();
    orThrow(await store.setIfNotExists('nonce:old', 1, 300));
    await db
      .update(table)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(table.key, 'nonce:old'));
    orThrow(await store.setIfNotExists('nonce:new', 1, 300));
    const rows = await db.select({ key: table.key }).from(table);
    expect(rows.map(row => row.key)).toEqual(['nonce:new']);
  });
});
