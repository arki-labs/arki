/**
 * The idempotency middleware against the real `offline_idempotency_keys`
 * table, through oRPC's own `implement(contract).use(...)` and
 * `createRouterClient` — which also proves the contract meta reaches the
 * middleware at run time (`MiddlewareOptions.procedure`).
 *
 * Three legs, same cases: PGlite (in-process), a real Postgres in a
 * testcontainer (needs Docker, like the other `*.pg.test.ts` suites), and
 * SQLite (libSQL, in memory) through the table written once and the SQLite
 * repository twin.
 */
import { PGlite } from '@electric-sql/pglite';
import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { defineRelations, sql } from 'drizzle-orm';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/payload/sqlite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pgSchema } from 'drizzle-orm/pg-core';

import { createLibsqlDb } from '@arki/db/libsql';
import { pgColumns } from '@arki/db/pg';
import { sqliteColumns } from '@arki/db/sqlite';
import { startPostgresContainer } from '@arki/testing/containers';
import { RandomSourceUnavailable } from '@arki/contracts';
import { isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import type { IdempotencyKeyId } from '../../src/orpc/idempotency-id';
import { idempotencyKeyId } from '../../src/orpc/idempotency-id';
import { IdempotencyStoreUnconfirmed } from '../../src/orpc/idempotency-failures';
import type { IdempotencyStore, IdempotentContext } from '../../src/orpc/idempotency';
import type { IdempotencyDatabase } from '../../src/orpc/idempotency-repository';
import { idempotency } from '../../src/orpc/idempotency';
import { idempotencyKeys } from '../../src/orpc/idempotency-keys';
import { IdempotencyRepository } from '../../src/orpc/idempotency-repository';
import { SqliteIdempotencyRepository } from '../../src/orpc/idempotency-repository-sqlite';
import { createIdempotencyTable } from '../../src/orpc/idempotency-table';
import { offlineSafe } from '../../src/orpc/offline-safe-marker';

const contract = {
  highlights: {
    create: offlineSafe(oc.input(z.object({ text: z.string() })).output(z.object({ id: z.string() }))),
    rename: oc.input(z.object({ text: z.string() })).output(z.object({ id: z.string() })),
  },
};

const CREATE_TABLE = sql`
  create table offline_idempotency_keys (
    id varchar(128) primary key,
    idempotency_key varchar(128) not null,
    procedure_path varchar(255) not null,
    user_id text not null,
    response_json jsonb not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  )`;
const CREATE_INDEX = sql`
  create unique index offline_idk_key_path_user_idx on offline_idempotency_keys (idempotency_key, procedure_path, user_id)`;

const CREATE_SQLITE_TABLES = async (db: ReturnType<typeof createLibsqlDb>['db'], tables: Record<string, unknown>) => {
  const empty = await generateDrizzleJson({});
  for (const statement of await generateMigration(empty, await generateDrizzleJson(tables))) {
    await db.run(sql.raw(statement));
  }
};

/** What one database offers the shared cases: the repository, plus real reads and writes on its table. */
type LegHandle = {
  readonly store: IdempotencyStore;
  readonly close: () => Promise<void>;
  /** Every cached row, as `{ id, procedurePath }`. */
  readonly rows: () => Promise<readonly { id: string; procedurePath: string }[]>;
  readonly clear: () => Promise<void>;
  /** Insert a row whose window already ended. */
  readonly insertExpired: (row: { id: IdempotencyKeyId; idempotencyKey: string; procedurePath: string; userId: string }) => Promise<void>;
  /** Run `action` and count the INSERT statements it started. */
  readonly countInserts: <T>(action: () => Promise<T>) => Promise<{ result: T; inserts: number }>;
};

type Leg = { readonly name: string; readonly open: () => Promise<LegHandle> };

function pgHandle(db: IdempotencyDatabase, close: () => Promise<void>): LegHandle {
  return {
    store: new IdempotencyRepository(db, idempotencyKeys),
    close,
    rows: () => db.select().from(idempotencyKeys),
    clear: async () => {
      await db.delete(idempotencyKeys);
    },
    insertExpired: async row => {
      await db.insert(idempotencyKeys).values({ ...row, responseJson: { id: 'hl_old' }, expiresAt: new Date(Date.now() - 1000) });
    },
    countInserts: async action => {
      const insert = vi.spyOn(db, 'insert');
      const result = await action();
      return { result, inserts: insert.mock.calls.length };
    },
  };
}

const legs: readonly Leg[] = [
  {
    name: 'PGlite',
    open: async () => {
      const client = new PGlite();
      const db = drizzlePglite({ client });
      await db.execute(CREATE_TABLE);
      await db.execute(CREATE_INDEX);
      return pgHandle(db, () => client.close());
    },
  },
  {
    name: 'Postgres (testcontainers)',
    open: async () => {
      const container = await startPostgresContainer();
      const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
      const db = drizzlePg({ client: pool });
      await db.execute(CREATE_TABLE);
      await db.execute(CREATE_INDEX);
      return pgHandle(db, async () => {
        await pool.end();
        await container.stop();
      });
    },
  },
  {
    name: 'SQLite (libSQL)',
    open: async () => {
      const table = createIdempotencyTable(sqliteColumns());
      const { db, close } = createLibsqlDb({ url: ':memory:', relations: defineRelations({ table }) });
      await CREATE_SQLITE_TABLES(db, { table });
      return {
        store: new SqliteIdempotencyRepository(db, table),
        close: () => Promise.resolve(close()),
        rows: () => db.select().from(table),
        clear: async () => {
          await db.run(sql`delete from offline_idempotency_keys`);
        },
        insertExpired: async row => {
          await db.insert(table).values({ ...row, responseJson: { id: 'hl_old' }, expiresAt: new Date(Date.now() - 1000) });
        },
        countInserts: async action => {
          const insert = vi.spyOn(db, 'insert');
          const result = await action();
          return { result, inserts: insert.mock.calls.length };
        },
      };
    },
  },
];

describe.each(legs)('idempotency on $name', leg => {
  let handle: LegHandle;

  beforeAll(async () => {
    handle = await leg.open();
  }, 120_000);

  afterAll(() => handle.close());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  beforeEach(async () => {
    await handle.clear();
  });

  /** `overlap`: each handler waits until two lookups happened, so two replays truly overlap. */
  function serve(key: string, overlap = false) {
    let runs = 0;
    let lookups = 0;
    let bothLookedUp: () => void = () => undefined;
    const twoLookups = new Promise<void>(resolve => (bothLookedUp = resolve));
    const repo = handle.store;
    const store: IdempotencyStore = {
      find: async (...args) => {
        const found = await repo.find(...args);
        if (++lookups === 2) bothLookedUp();
        return found;
      },
      store: (...args) => repo.store(...args),
    };
    const impl = implement(contract).$context<IdempotentContext>().use(idempotency(store));
    const handler = async () => {
      const run = ++runs;
      if (overlap) await twoLookups;
      return { id: `hl_${String(run)}` };
    };
    const router = impl.router({
      highlights: { create: impl.highlights.create.handler(handler), rename: impl.highlights.rename.handler(handler) },
    });
    const context: IdempotentContext = { headers: new Headers({ 'Idempotency-Key': key, 'Offline-Actor': 'usr_1' }), session: { user: { id: 'usr_1' } } };
    return { client: createRouterClient(router, { context }), runs: () => runs };
  }

  it('a marked procedure replayed with the same key runs once', async () => {
    const { client, runs } = serve('k1');
    const first = await client.highlights.create({ text: 'a' });
    const replay = await client.highlights.create({ text: 'a' });
    expect(replay).toEqual(first);
    expect(runs()).toBe(1);
    const rows = await handle.rows();
    expect(rows.map(row => row.procedurePath)).toEqual(['highlights.create']);
    expect(rows[0]?.id).toMatch(/^idk_[\w-]{21}$/);
  });

  it('returns the original entropy refusal before attempting an insert', async () => {
    const refusal = RandomSourceUnavailable();
    vi.spyOn(idempotencyKeyId, 'create').mockReturnValueOnce(refusal);
    const { result, inserts } = await handle.countInserts(() => handle.store.store('key', 'posts.create', 'usr_1', { id: 'post_1' }));
    expect(result).toBe(refusal);
    expect(inserts).toBe(0);
    expect(await handle.rows()).toEqual([]);
  });

  it('fails closed without entropy and supervises a throwing provider before SQL', async () => {
    const { inserts } = await handle.countInserts(async () => {
      vi.stubGlobal('crypto', {});
      expect(RandomSourceUnavailable.is(await handle.store.store('key', 'path', 'user', null))).toBe(true);
      const cause = new Error('private entropy detail');
      vi.stubGlobal('crypto', { getRandomValues() { throw cause; } });
      const result = await handle.store.store('key', 'path', 'user', null);
      expect(UnexpectedDefect.is(result)).toBe(true);
      expect(isFailure(result) && result.cause).toBe(cause);
      expect(JSON.stringify(result)).not.toContain('private entropy detail');
    });
    expect(inserts).toBe(0);
  });

  it('returns an unconfirmed write when the database rejects the statement', async () => {
    const result = await handle.store.store('x'.repeat(129), 'path', 'usr_1', { secret: 'private response' });
    expect(IdempotencyStoreUnconfirmed.is(result)).toBe(true);
    expect(isFailure(result) && result.cause).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('private response');
    expect(await handle.rows()).toEqual([]);
  });

  it('an unmarked procedure with the same key runs every time', async () => {
    const { client, runs } = serve('k1');
    await client.highlights.rename({ text: 'a' });
    await client.highlights.rename({ text: 'a' });
    expect(runs()).toBe(2);
  });

  it('an expired row does not answer: the replay runs again', async () => {
    await handle.insertExpired({
      id: orThrow(idempotencyKeyId.create()),
      idempotencyKey: 'k1',
      procedurePath: 'highlights.create',
      userId: 'usr_1',
    });
    const { client, runs } = serve('k1');
    await expect(client.highlights.create({ text: 'a' })).resolves.toEqual({ id: 'hl_1' });
    expect(runs()).toBe(1);
  });

  it('BOUNDARY, not exactly-once: two replays arriving together can both run the handler', async () => {
    const { client, runs } = serve('k1', true);
    await Promise.all([client.highlights.create({ text: 'a' }), client.highlights.create({ text: 'a' })]);
    // Lookup, run and store are separate steps; the README says so. A transactional
    // claim would make this 1 — that is a separate task.
    expect(runs()).toBe(2);
  });
});

describe('idempotency table in a Postgres schema', () => {
  const client = new PGlite();
  const db = drizzlePglite({ client });

  beforeAll(async () => {
    await db.execute(CREATE_TABLE);
    await db.execute(CREATE_INDEX);
  });

  afterAll(() => client.close());

  it('uses the same nominal definition in namespaced tables without an implicit default', async () => {
    const namespaced = createIdempotencyTable(pgColumns(pgSchema('id09')));
    await db.execute(sql`create schema if not exists id09`);
    await db.execute(sql`create table id09.offline_idempotency_keys (like public.offline_idempotency_keys including all)`);
    try {
      const repo = new IdempotencyRepository(db, namespaced);
      expect(await repo.store('key', 'path', 'usr_1', { id: 'response' })).toBeUndefined();
      const rows = await db.select().from(namespaced);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toMatch(/^idk_[\w-]{21}$/);
      expect(await repo.find('key', 'path', 'usr_1')).toEqual({ id: 'response' });
      expect(namespaced.id.hasDefault).toBe(false);
      expect(idempotencyKeys.id.hasDefault).toBe(false);
      expect(idempotencyKeyId.schema.parse('idk_historical')).toBe('idk_historical');
    } finally {
      await db.execute(sql`drop schema id09 cascade`);
    }
  });
});
