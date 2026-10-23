/// <reference types="node" />
/**
 * The SQLite backend on libSQL, on a temporary file (each libSQL transaction has
 * its own connection, so `:memory:` would give it an empty database). The
 * conformance suite proves the contract; the cases below cover retention, the
 * default table and setup errors.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/payload/sqlite';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLibsqlDb } from '@arki/db/libsql';

import { describePubSubContract } from '../testing/index.js';
import { pubsubTable, sqlitePubSub } from './index.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const table = pubsubTable();
const other = pubsubTable('other_pubsub');

const folder = mkdtempSync(path.join(tmpdir(), 'arki-pubsub-'));
const libsql = createLibsqlDb({ url: `file:${path.join(folder, 'pubsub.db')}`, relations: defineRelations({}) });
const { db } = libsql;

beforeAll(async () => {
  const statements = await generateMigration(
    await generateDrizzleJson({}),
    await generateDrizzleJson({ table, other }),
  );
  for (const statement of statements) await db.run(sql.raw(statement));
});

afterAll(() => {
  libsql.close();
  rmSync(folder, { recursive: true, force: true });
});

describePubSubContract(
  'sqlite on libSQL',
  () => Promise.resolve({ pubsub: sqlitePubSub({ db, intervalMs: 10 }), transaction: fn => db.transaction(fn) }),
  { settleMs: 80 },
);

describe('sqlite table and retention', () => {
  it('the next publisher deletes rows older than retainMs, and keeps younger ones', async () => {
    const pubsub = sqlitePubSub({ db, retainMs: 80 });
    await pubsub.publish('retention', 'old');
    await sleep(160);
    await pubsub.publish('retention', 'new');
    await pubsub.publish('retention', 'newer');
    const rows = await db.select({ payload: table.payload }).from(table).where(eq(table.channel, 'retention'));
    expect(rows).toEqual([{ payload: 'new' }, { payload: 'newer' }]);
    await pubsub.close();
  });

  it('uses the table it is given', async () => {
    const pubsub = sqlitePubSub({ db, table: other, intervalMs: 10 });
    const received: string[] = [];
    await pubsub.subscribe('own_table', payload => received.push(payload));
    await pubsub.publish('own_table', 'here');
    const rows = await db.select({ payload: other.payload }).from(other);
    expect(rows).toEqual([{ payload: 'here' }]);
    await sleep(80);
    expect(received).toEqual(['here']);
    await pubsub.close();
  });

  it('refuses a non-positive interval or retention with a config error', () => {
    expect(() => sqlitePubSub({ db, intervalMs: 0 })).toThrow(expect.objectContaining({ code: 'config' }));
    expect(() => sqlitePubSub({ db, retainMs: Number.NaN })).toThrow(expect.objectContaining({ code: 'config' }));
  });
});
