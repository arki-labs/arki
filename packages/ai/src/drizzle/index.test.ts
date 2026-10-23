/**
 * The tombstone outbox on a real Postgres (PGlite) and a real SQLite (libSQL,
 * in memory), through one shared behavior: one row per point id written in the
 * caller's transaction, cleared by point id after a direct erasure, drained
 * oldest-first by exact id — and statements chunked so an account deletion
 * with tens of thousands of points stays under the bind-parameter ceiling.
 * Ids keep the table's brands end to end.
 */
import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/payload/sqlite';
import { defineRelations, sql } from 'drizzle-orm';
import { pgSchema } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IdGenerationFailure, z } from '@arki/contracts';
import { RandomSourceUnavailable } from '@arki/contracts';
import { createLibsqlDb } from '@arki/db/libsql';
import { pgColumns } from '@arki/db/pg';
import { sqliteColumns } from '@arki/db/sqlite';

import { createTombstoneTable, tombstoneOutbox } from './index';
import { sqliteTombstoneOutbox } from './sqlite';

/** The app's user id brand, as the tables type it. */
type UserId = `u_${string}`;

/** One row as the reconciler sees it. */
type TombstoneRow = { id: string; pointId: string };

/** What one dialect's outbox can do, over a real database. */
type OutboxOps = {
  /** Empty the tombstone table. */
  reset(): Promise<void>;
  /** `write` inside a database transaction. */
  writeInTransaction(userId: UserId, pointIds: readonly string[]): Promise<void>;
  /** `write` straight on the database. */
  write(userId: UserId, pointIds: readonly string[]): Promise<void>;
  clear(pointIds: readonly string[]): Promise<void>;
  list(limit: number): Promise<TombstoneRow[]>;
  remove(ids: readonly string[]): Promise<void>;
  /** Make one tombstone strictly older than the rest, so the drain order is observable. */
  makeOlder(pointId: string): Promise<void>;
  /** Run `action` and count the INSERT and DELETE statements it started. */
  countStatements(action: () => Promise<void>): Promise<{ inserts: number; deletes: number }>;
};

const USER: UserId = 'u_1';

/** The behavior every dialect's outbox must show. The assertions do not know which database answers. */
function describeTombstoneOutbox(dialect: string, ops: OutboxOps): void {
  describe(`tombstoneOutbox on ${dialect}`, () => {
    beforeEach(async () => {
      await ops.reset();
    });

    it('write inside a transaction, list oldest first with branded ids, remove by exact id', async () => {
      await ops.writeInTransaction(USER, ['citm_1', 'schk_1']);
      await ops.makeOlder('citm_1');
      const listed = await ops.list(10);
      expect(listed.map(t => t.pointId)).toEqual(['citm_1', 'schk_1']);
      expect(listed.every(t => t.id.startsWith('vtmb_'))).toBe(true);

      await ops.remove(listed.slice(0, 1).map(t => t.id));
      const remaining = await ops.list(10);
      expect(remaining.map(t => t.pointId)).toEqual(['schk_1']);
    });

    it('clear removes by point id and is a no-op on an empty list', async () => {
      await ops.write(USER, ['citm_1', 'schk_1', 'hlgt_1']);
      const empty = await ops.countStatements(() => ops.clear([]));
      expect(empty.deletes).toBe(0);
      await ops.clear(['citm_1', 'hlgt_1']);
      const remaining = await ops.list(10);
      expect(remaining.map(t => t.pointId)).toEqual(['schk_1']);
    });

    it('chunks inserts at 5000 rows and deletes at 10000 ids', async () => {
      const ids = Array.from({ length: 10_001 }, (_, i) => `p_${i}`);
      const written = await ops.countStatements(() => ops.write(USER, ids));
      expect(written.inserts).toBe(3); // 5000 + 5000 + 1
      expect(await ops.list(20_000)).toHaveLength(10_001);

      const cleared = await ops.countStatements(() => ops.clear(ids));
      expect(cleared.deletes).toBe(2); // 10000 + 1
      expect(await ops.list(10)).toHaveLength(0);
      // 10,001 real rows: a few seconds on a busy machine, over vitest's 5 s default.
    }, 30_000);

    it('list respects the limit and write is a no-op on an empty list', async () => {
      const empty = await ops.countStatements(() => ops.write(USER, []));
      expect(empty.inserts).toBe(0);
      await ops.write(USER, ['a', 'b', 'c']);
      expect(await ops.list(2)).toHaveLength(2);
    });

    it('remove is a no-op on an empty list', async () => {
      await ops.write(USER, ['a']);
      const removed = await ops.countStatements(() => ops.remove([]));
      expect(removed.deletes).toBe(0);
      expect(await ops.list(10)).toHaveLength(1);
    });
  });
}

// ── Postgres (PGlite) ────────────────────────────────────────

const schema = pgSchema('ai_test');
const pgKit = pgColumns(schema);
const { table: PgTombstone, id: pgTombstoneId } = createTombstoneTable<'pg', UserId, 'vtmb_'>(pgKit, {
  name: 'vector_tombstones',
  idPrefix: 'vtmb_',
});
const pgOutbox = tombstoneOutbox(PgTombstone);

const pgClient = new PGlite();
const pgDb = drizzle({ client: pgClient });
const pgStore = pgOutbox.store(pgDb);

beforeAll(async () => {
  await pgClient.exec(`
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

afterAll(async () => {
  await pgClient.close();
});

describe('createTombstoneTable on Postgres', () => {
  it.each(['', 'old-/ .'])('preserves existing arbitrary prefix %j through declarations and column schemas', prefix => {
    const { table, id } = createTombstoneTable(pgKit, { name: 'prefix_compat', idPrefix: prefix });
    const generated = id.create();
    expect(id.prefix).toBe(prefix);
    expect(id.schema.safeParse(generated).success).toBe(true);
    expect(table.id.name).toBe('id');
    expect(id.schema.parse(`${prefix}existing`)).toBe(`${prefix}existing`);
  });
  it('exposes the canonical generation refusal without widening stored row IDs', () => {
    vi.stubGlobal('crypto', {});
    try {
      expect(RandomSourceUnavailable.is(pgTombstoneId.create())).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('mints prefixed ids and types the user column with the app brand', () => {
    expect(pgTombstoneId.create()).toMatch(/^vtmb_/);
    expectTypeOf<ReturnType<typeof pgTombstoneId.create>>().toEqualTypeOf<`vtmb_${string}` | IdGenerationFailure>();
    expectTypeOf<z.output<typeof pgTombstoneId.schema>>().toEqualTypeOf<`vtmb_${string}`>();
    expectTypeOf<typeof PgTombstone.$inferSelect>().toEqualTypeOf<{
      id: `vtmb_${string}`;
      pointId: string;
      userId: UserId;
      createdAt: typeof PgTombstone.$inferSelect.createdAt;
    }>();
  });
});

describeTombstoneOutbox('Postgres', {
  reset: async () => {
    await pgClient.exec('TRUNCATE ai_test.vector_tombstones');
  },
  writeInTransaction: (userId, pointIds) =>
    pgDb.transaction(async tx => {
      await pgOutbox.write(tx, userId, pointIds);
    }),
  write: (userId, pointIds) => pgOutbox.write(pgDb, userId, pointIds),
  clear: pointIds => pgOutbox.clear(pgDb, pointIds),
  list: async limit => {
    const rows = await pgStore.list(limit);
    expectTypeOf<(typeof rows)[number]['id']>().toEqualTypeOf<`vtmb_${string}`>();
    return rows;
  },
  remove: async ids => {
    await pgStore.remove(ids.map(id => pgTombstoneId.schema.parse(id)));
  },
  makeOlder: async pointId => {
    await pgClient.query(
      `UPDATE ai_test.vector_tombstones SET created_at = created_at - interval '1 hour' WHERE point_id = $1`,
      [pointId],
    );
  },
  countStatements: async action => {
    const insert = vi.spyOn(pgDb, 'insert');
    const del = vi.spyOn(pgDb, 'delete');
    try {
      await action();
      return { inserts: insert.mock.calls.length, deletes: del.mock.calls.length };
    } finally {
      insert.mockRestore();
      del.mockRestore();
    }
  },
});

// ── SQLite (libSQL, in memory) ───────────────────────────────

const { table: SqliteTombstone, id: sqliteTombstoneId } = createTombstoneTable<'sqlite', UserId, 'vtmb_'>(
  sqliteColumns(),
  { name: 'vector_tombstones', idPrefix: 'vtmb_' },
);
const sqliteOutbox = sqliteTombstoneOutbox(SqliteTombstone);

const { db: sqliteDb, close: closeSqlite } = createLibsqlDb({
  url: ':memory:',
  relations: defineRelations({ SqliteTombstone }),
});
const sqliteStore = sqliteOutbox.store(sqliteDb);

beforeAll(async () => {
  const empty = await generateDrizzleJson({});
  const statements = await generateMigration(empty, await generateDrizzleJson({ SqliteTombstone }));
  for (const statement of statements) await sqliteDb.run(sql.raw(statement));
});

afterAll(() => {
  closeSqlite();
});

describe('createTombstoneTable on SQLite', () => {
  it('types ids and the user column like the Postgres table', () => {
    expectTypeOf<typeof SqliteTombstone.$inferSelect>().toEqualTypeOf<{
      id: `vtmb_${string}`;
      pointId: string;
      userId: UserId;
      createdAt: typeof SqliteTombstone.$inferSelect.createdAt;
    }>();
    expect(sqliteTombstoneId.create()).toMatch(/^vtmb_/);
  });

  it('turns the varchar limit into a CHECK that rejects an over-long point id', async () => {
    await expect(sqliteOutbox.write(sqliteDb, USER, ['x'.repeat(257)])).rejects.toThrow();
  });
});

describeTombstoneOutbox('SQLite', {
  reset: async () => {
    await sqliteDb.run(sql`DELETE FROM vector_tombstones`);
  },
  writeInTransaction: (userId, pointIds) =>
    sqliteDb.transaction(async tx => {
      await sqliteOutbox.write(tx, userId, pointIds);
    }),
  write: (userId, pointIds) => sqliteOutbox.write(sqliteDb, userId, pointIds),
  clear: pointIds => sqliteOutbox.clear(sqliteDb, pointIds),
  list: async limit => {
    const rows = await sqliteStore.list(limit);
    expectTypeOf<(typeof rows)[number]['id']>().toEqualTypeOf<`vtmb_${string}`>();
    return rows;
  },
  remove: async ids => {
    await sqliteStore.remove(ids.map(id => sqliteTombstoneId.schema.parse(id)));
  },
  makeOlder: async pointId => {
    await sqliteDb.run(sql`UPDATE vector_tombstones SET created_at = created_at - 3600000 WHERE point_id = ${pointId}`);
  },
  countStatements: async action => {
    const insert = vi.spyOn(sqliteDb, 'insert');
    const del = vi.spyOn(sqliteDb, 'delete');
    try {
      await action();
      return { inserts: insert.mock.calls.length, deletes: del.mock.calls.length };
    } finally {
      insert.mockRestore();
      del.mockRestore();
    }
  },
});
