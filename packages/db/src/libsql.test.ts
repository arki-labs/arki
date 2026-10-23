/**
 * The libSQL driver and its write queue. SQLite has one writer, and every
 * pooled connection shares the one JavaScript thread, so without the queue a
 * second writer fails at once with SQLITE_BUSY. Each case pins one way the
 * queue could be wrong: too loose (BUSY), too tight (a deadlock), or leaky (a
 * failed transaction that never gives the turn back).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createClient } from '@libsql/client';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLibsqlDb, isLocalLibsqlUrl } from './libsql.js';

const rows = sqliteTable('rows', { id: integer('id').primaryKey(), k: text('k').notNull() });
const relations = defineRelations({ rows });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

let dir: string;
let opened: ReturnType<typeof createLibsqlDb<typeof relations>>;

async function open(url = `file:${path.join(dir, 'app.db')}`) {
  opened = createLibsqlDb({ url, relations });
  await opened.db.run(sql`create table if not exists rows (id integer primary key, k text not null)`);
  return opened.db;
}

describe('createLibsqlDb', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'arki-libsql-'));
  });

  afterEach(() => {
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets 8 transactions, 8 plain inserts and 8 selects run at once without SQLITE_BUSY', async () => {
    // The spike's failing scenario: on a bare client the second writer gets SQLITE_BUSY.
    const db = await open();
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) =>
        db.transaction(async tx => {
          await tx.insert(rows).values({ k: `tx${i}` });
          await tick();
        }),
      ),
      ...Array.from({ length: 8 }, async (_, i) => {
        await tick();
        await db.insert(rows).values({ k: `plain${i}` });
      }),
      ...Array.from({ length: 8 }, async () => {
        await tick();
        await db.select().from(rows);
      }),
    ]);
    expect(await db.$count(rows)).toBe(16);
  });

  it('fails the same load with SQLITE_BUSY on a bare client: the queue is what fixes it', async () => {
    // Control: without it, the case above would pass even if the queue did nothing.
    await open();
    const client = createClient({ url: `file:${path.join(dir, 'app.db')}` });
    const bare = drizzle({ client });
    try {
      const load = Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          bare.transaction(async tx => {
            await tx.insert(rows).values({ k: `bare${i}` });
            await tick();
          }),
        ),
      );
      await expect(load).rejects.toMatchObject({ cause: { code: 'SQLITE_BUSY' } });
    } finally {
      client.close();
    }
  });

  it('rolls back a throw after an await, and the next transaction still gets the turn', async () => {
    // A failed transaction that kept its turn would stop every later write.
    const db = await open();
    await expect(
      db.transaction(async tx => {
        await tx.insert(rows).values({ k: 'lost' });
        await tick();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await db.transaction(async tx => {
      await tx.insert(rows).values({ k: 'kept' });
    });
    const left = await db.select().from(rows);
    expect(left.map(row => row.k)).toEqual(['kept']);
  });

  it('runs queries inside a transaction without waiting on the queue', async () => {
    // If a transaction's own queries took a turn, it would wait for itself forever.
    const db = await open();
    const found = await db.transaction(async tx => {
      await tx.insert(rows).values({ k: 'inside' });
      await tx.transaction(async nested => {
        await nested.insert(rows).values({ k: 'savepoint' });
      });
      return tx.select().from(rows).where(eq(rows.k, 'inside'));
    });
    expect(found).toHaveLength(1);
    expect(await db.$count(rows)).toBe(2);
  });

  it('works on :memory:, which has a single connection', async () => {
    const db = await open(':memory:');
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        db.transaction(async tx => {
          await tx.insert(rows).values({ k: `m${i}` });
          await tick();
        }),
      ),
    );
    expect(await db.$count(rows)).toBe(4);
  });
});

describe('isLocalLibsqlUrl', () => {
  it('queues only databases in this process; a server does its own locking', () => {
    expect(isLocalLibsqlUrl('file:./app.db')).toBe(true);
    expect(isLocalLibsqlUrl(':memory:')).toBe(true);
    expect(isLocalLibsqlUrl('libsql://app-org.turso.io')).toBe(false);
    expect(isLocalLibsqlUrl('https://app-org.turso.io')).toBe(false);
  });
});
