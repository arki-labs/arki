/**
 * The idempotency middleware against the real `offline_idempotency_keys`
 * table, through oRPC's own `implement(contract).use(...)` and
 * `createRouterClient` — which also proves the contract meta reaches the
 * middleware at run time (`MiddlewareOptions.procedure`).
 *
 * Two legs, same cases: PGlite (in-process) and a real Postgres in a
 * testcontainer (needs Docker, like the other `*.pg.test.ts` suites).
 */
import { PGlite } from '@electric-sql/pglite';
import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pgSchema } from 'drizzle-orm/pg-core';

import { startPostgresContainer } from '@arki/testing/containers';
import { RandomSourceUnavailable } from '@arki/contracts';
import { isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import { idempotencyKeyId } from '../../src/orpc/idempotency-id';
import { IdempotencyStoreUnconfirmed } from '../../src/orpc/idempotency-failures';
import type { IdempotencyStore, IdempotentContext } from '../../src/orpc/idempotency';
import type { IdempotencyDatabase } from '../../src/orpc/idempotency-repository';
import { idempotency } from '../../src/orpc/idempotency';
import { IdempotencyRepository } from '../../src/orpc/idempotency-repository';
import { createIdempotencyTable, idempotencyKeys } from '../../src/orpc/idempotency-table';
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

type Leg = { readonly name: string; readonly open: () => Promise<{ db: IdempotencyDatabase; close: () => Promise<void> }> };

const legs: readonly Leg[] = [
  {
    name: 'PGlite',
    open: async () => {
      const client = new PGlite();
      return { db: drizzlePglite({ client }), close: () => client.close() };
    },
  },
  {
    name: 'Postgres (testcontainers)',
    open: async () => {
      const container = await startPostgresContainer();
      const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
      return {
        db: drizzlePg({ client: pool }),
        close: async () => {
          await pool.end();
          await container.stop();
        },
      };
    },
  },
];

describe.each(legs)('idempotency on $name', leg => {
  let db: IdempotencyDatabase;
  let close: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    ({ db, close } = await leg.open());
    await db.execute(CREATE_TABLE);
    await db.execute(CREATE_INDEX);
  }, 120_000);

  afterAll(() => close());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  beforeEach(async () => {
    await db.delete(idempotencyKeys);
  });

  /** `overlap`: each handler waits until two lookups happened, so two replays truly overlap. */
  function serve(key: string, overlap = false) {
    let runs = 0;
    let lookups = 0;
    let bothLookedUp: () => void = () => undefined;
    const twoLookups = new Promise<void>(resolve => (bothLookedUp = resolve));
    const repo = new IdempotencyRepository(db, idempotencyKeys);
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
    const rows = await db.select().from(idempotencyKeys);
    expect(rows.map(row => row.procedurePath)).toEqual(['highlights.create']);
    expect(rows[0]?.id).toMatch(/^idk_[\w-]{21}$/);
  });

  it('returns the original entropy refusal before attempting an insert', async () => {
    const refusal = RandomSourceUnavailable();
    vi.spyOn(idempotencyKeyId, 'create').mockReturnValueOnce(refusal);
    const insert = vi.spyOn(db, 'insert');
    const repo = new IdempotencyRepository(db, idempotencyKeys);
    expect(await repo.store('key', 'posts.create', 'usr_1', { id: 'post_1' })).toBe(refusal);
    expect(insert).not.toHaveBeenCalled();
    expect(await db.select().from(idempotencyKeys)).toEqual([]);
  });

  it('fails closed without entropy and supervises a throwing provider before SQL', async () => {
    vi.stubGlobal('crypto', {});
    const insert = vi.spyOn(db, 'insert');
    const repo = new IdempotencyRepository(db, idempotencyKeys);
    expect(RandomSourceUnavailable.is(await repo.store('key', 'path', 'user', null))).toBe(true);
    const cause = new Error('private entropy detail');
    vi.stubGlobal('crypto', { getRandomValues() { throw cause; } });
    const result = await repo.store('key', 'path', 'user', null);
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(isFailure(result) && result.cause).toBe(cause);
    expect(JSON.stringify(result)).not.toContain('private entropy detail');
    expect(insert).not.toHaveBeenCalled();
  });

  it('returns an unconfirmed write when the database rejects the statement', async () => {
    const repo = new IdempotencyRepository(db, idempotencyKeys);
    const result = await repo.store('x'.repeat(129), 'path', 'usr_1', { secret: 'private response' });
    expect(IdempotencyStoreUnconfirmed.is(result)).toBe(true);
    expect(isFailure(result) && result.cause).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('private response');
    expect(await db.select().from(idempotencyKeys)).toEqual([]);
  });

  it('uses the same nominal definition in namespaced tables without an implicit default', async () => {
    const namespaced = createIdempotencyTable(pgSchema('id09'));
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

  it('an unmarked procedure with the same key runs every time', async () => {
    const { client, runs } = serve('k1');
    await client.highlights.rename({ text: 'a' });
    await client.highlights.rename({ text: 'a' });
    expect(runs()).toBe(2);
  });

  it('an expired row does not answer: the replay runs again', async () => {
    await db.insert(idempotencyKeys).values({
      id: orThrow(idempotencyKeyId.create()),
      idempotencyKey: 'k1',
      procedurePath: 'highlights.create',
      userId: 'usr_1',
      responseJson: { id: 'hl_old' },
      expiresAt: new Date(Date.now() - 1_000),
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
