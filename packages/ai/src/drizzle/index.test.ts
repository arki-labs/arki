/**
 * The tombstone outbox on a real Postgres (PGlite): one row per point id
 * written in the caller's transaction, cleared by point id after a direct
 * erasure, drained oldest-first by exact id — and statements chunked so an
 * account deletion with tens of thousands of points stays under Postgres's
 * bind-parameter ceiling. Ids keep the table's brands end to end.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgSchema } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IdGenerationFailure, z } from '@arki/contracts';
import { RandomSourceUnavailable } from '@arki/contracts';

import { createTombstoneTable, tombstoneOutbox } from './index';

type UserId = `u_${string}`;

const schema = pgSchema('ai_test');
const { table: Tombstone, id: tombstoneId } = createTombstoneTable<UserId, 'vtmb_'>(schema, {
  name: 'vector_tombstones',
  idPrefix: 'vtmb_',
});
const outbox = tombstoneOutbox(Tombstone);

const client = new PGlite();
const db = drizzle({ client });
const USER: UserId = 'u_1';

beforeAll(async () => {
  await client.exec(`
    CREATE SCHEMA ai_test;
    CREATE TABLE ai_test.vector_tombstones (
      id varchar(256) PRIMARY KEY,
      point_id varchar(256) NOT NULL,
      user_id varchar(256) NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_vector_tombstones_created ON ai_test.vector_tombstones (created_at);
  `);
});

beforeEach(async () => {
  await client.exec('TRUNCATE ai_test.vector_tombstones');
});

afterAll(async () => {
  await client.close();
});

describe('createTombstoneTable', () => {
  it.each(['', 'old-/ .'])('preserves existing arbitrary prefix %j through declarations and column schemas', prefix => {
    const { table, id } = createTombstoneTable(schema, { name: 'prefix_compat', idPrefix: prefix });
    const generated = id.create();
    expect(id.prefix).toBe(prefix);
    expect(id.schema.safeParse(generated).success).toBe(true);
    expect(table.id.name).toBe('id');
    expect(id.schema.parse(`${prefix}existing`)).toBe(`${prefix}existing`);
  });
  it('exposes the canonical generation refusal without widening stored row IDs', () => {
    vi.stubGlobal('crypto', {});
    try {
      expect(RandomSourceUnavailable.is(tombstoneId.create())).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('mints prefixed ids and types the user column with the app brand', () => {
    expect(tombstoneId.create()).toMatch(/^vtmb_/);
    expectTypeOf<ReturnType<typeof tombstoneId.create>>().toEqualTypeOf<`vtmb_${string}` | IdGenerationFailure>();
    expectTypeOf<z.output<typeof tombstoneId.schema>>().toEqualTypeOf<`vtmb_${string}`>();
    expectTypeOf<typeof Tombstone.$inferSelect>().toEqualTypeOf<{
      id: `vtmb_${string}`;
      pointId: string;
      userId: UserId;
      createdAt: typeof Tombstone.$inferSelect.createdAt;
    }>();
  });
});

describe('tombstoneOutbox', () => {
  it('write inside a transaction, list oldest first with branded ids, remove by exact id', async () => {
    await db.transaction(async tx => {
      await outbox.write(tx, USER, ['citm_1', 'schk_1']);
    });
    // Both rows share the transaction's `now()`; make `citm_1` strictly older so the drain order is observable.
    await client.exec(
      `UPDATE ai_test.vector_tombstones SET created_at = created_at - interval '1 hour' WHERE point_id = 'citm_1'`,
    );
    const store = outbox.store(db);
    const listed = await store.list(10);
    expectTypeOf<(typeof listed)[number]['id']>().toEqualTypeOf<`vtmb_${string}`>();
    expect(listed.map(t => t.pointId)).toEqual(['citm_1', 'schk_1']);
    expect(listed.every(t => t.id.startsWith('vtmb_'))).toBe(true);

    await store.remove(listed.slice(0, 1).map(t => t.id));
    const remaining = await store.list(10);
    expect(remaining.map(t => t.pointId)).toEqual(['schk_1']);
  });

  it('clear removes by point id and is a no-op on an empty list', async () => {
    await outbox.write(db, USER, ['citm_1', 'schk_1', 'hlgt_1']);
    const del = vi.spyOn(db, 'delete');
    await outbox.clear(db, []);
    expect(del).not.toHaveBeenCalled();
    await outbox.clear(db, ['citm_1', 'hlgt_1']);
    const remaining = await outbox.store(db).list(10);
    expect(remaining.map(t => t.pointId)).toEqual(['schk_1']);
  });

  it('chunks inserts at 5000 rows and deletes at 10000 ids', async () => {
    const ids = Array.from({ length: 10_001 }, (_, i) => `p_${i}`);
    const insert = vi.spyOn(db, 'insert');
    await outbox.write(db, USER, ids);
    expect(insert).toHaveBeenCalledTimes(3); // 5000 + 5000 + 1
    expect(await outbox.store(db).list(20_000)).toHaveLength(10_001);

    const del = vi.spyOn(db, 'delete');
    await outbox.clear(db, ids);
    expect(del).toHaveBeenCalledTimes(2); // 10000 + 1
    expect(await outbox.store(db).list(10)).toHaveLength(0);
    // 10,001 real PGlite rows: a few seconds on a busy machine, over vitest's 5 s default.
  }, 30_000);

  it('list respects the limit and write is a no-op on an empty list', async () => {
    const insert = vi.spyOn(db, 'insert');
    await outbox.write(db, USER, []);
    expect(insert).not.toHaveBeenCalled();
    await outbox.write(db, USER, ['a', 'b', 'c']);
    expect(await outbox.store(db).list(2)).toHaveLength(2);
  });
});
