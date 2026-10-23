/// <reference types="node" />
/**
 * The poll backend on real databases: PGlite (an in-process Postgres) and libSQL
 * on a temporary file. The conformance suite proves the contract on each; the
 * cases below cover retention and setup errors.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/payload/sqlite';
import { count, defineRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLibsqlDb } from '@arki/db/libsql';
import { pgColumns } from '@arki/db/pg';
import { sqliteColumns } from '@arki/db/sqlite';

import { describePubSubContract } from '../testing/index.js';
import { pollPubSub, pubsubTable } from './index.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const pgTable = pubsubTable(pgColumns());
const sqliteTable = pubsubTable(sqliteColumns());

const pglite = new PGlite();
const pgDb = drizzle({ client: pglite });

const folder = mkdtempSync(path.join(tmpdir(), 'arki-pubsub-'));
const libsql = createLibsqlDb({ url: `file:${path.join(folder, 'pubsub.db')}`, relations: defineRelations({}) });
const sqliteDb = libsql.db;

beforeAll(async () => {
  const { apply } = await pushSchema({ pgTable }, pgDb);
  await apply();
  const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ sqliteTable }));
  for (const statement of statements) await sqliteDb.run(sql.raw(statement));
});

afterAll(async () => {
  await pglite.close();
  libsql.close();
  rmSync(folder, { recursive: true, force: true });
});

describePubSubContract(
  'poll on PGlite',
  () =>
    Promise.resolve({
      pubsub: pollPubSub({ db: pgDb, table: pgTable, intervalMs: 10 }),
      transaction: fn => pgDb.transaction(fn),
    }),
  { settleMs: 80 },
);

describePubSubContract(
  'poll on libSQL',
  () =>
    Promise.resolve({
      pubsub: pollPubSub({ db: sqliteDb, table: sqliteTable, intervalMs: 10 }),
      transaction: fn => sqliteDb.transaction(fn),
    }),
  { settleMs: 80 },
);

describe('poll retention', () => {
  it('the next publisher deletes rows older than retainMs (Postgres)', async () => {
    const pubsub = pollPubSub({ db: pgDb, table: pgTable, retainMs: 50 });
    await pubsub.publish('retention_pg', 'old');
    await sleep(120);
    await pubsub.publish('retention_pg', 'new');
    const rows = await pgDb.select({ payload: pgTable.payload }).from(pgTable);
    expect(rows).toEqual([{ payload: 'new' }]);
    await pubsub.close();
  });

  it('the next publisher deletes rows older than retainMs (SQLite)', async () => {
    const pubsub = pollPubSub({ db: sqliteDb, table: sqliteTable, retainMs: 50 });
    await pubsub.publish('retention_sqlite', 'old');
    await sleep(120);
    await pubsub.publish('retention_sqlite', 'new');
    const rows = await sqliteDb.select({ payload: sqliteTable.payload }).from(sqliteTable);
    expect(rows).toEqual([{ payload: 'new' }]);
    await pubsub.close();
  });

  it('keeps rows younger than retainMs', async () => {
    const pubsub = pollPubSub({ db: sqliteDb, table: sqliteTable });
    await pubsub.publish('retention_keep', 'a');
    await pubsub.publish('retention_keep', 'b');
    const [row] = await sqliteDb
      .select({ rows: count() })
      .from(sqliteTable)
      .where(sql`${sqliteTable.channel} = 'retention_keep'`);
    expect(row?.rows).toBe(2);
    await pubsub.close();
  });
});

describe('poll setup', () => {
  it('refuses a non-positive interval or retention with a config error', () => {
    expect(() => pollPubSub({ db: pgDb, table: pgTable, intervalMs: 0 })).toThrow(
      expect.objectContaining({ code: 'config' }),
    );
    expect(() => pollPubSub({ db: sqliteDb, table: sqliteTable, retainMs: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'config' }),
    );
  });
});
