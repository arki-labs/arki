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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startPostgresContainer } from '@arki/testing/containers';

import type { IdempotencyStore, IdempotentContext } from '../../src/orpc/idempotency';
import type { IdempotencyDatabase } from '../../src/orpc/idempotency-repository';
import { idempotency } from '../../src/orpc/idempotency';
import { IdempotencyRepository } from '../../src/orpc/idempotency-repository';
import { idempotencyKeys } from '../../src/orpc/idempotency-table';
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
    const context: IdempotentContext = { headers: new Headers({ 'Idempotency-Key': key }), session: { user: { id: 'usr_1' } } };
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
  });

  it('an unmarked procedure with the same key runs every time', async () => {
    const { client, runs } = serve('k1');
    await client.highlights.rename({ text: 'a' });
    await client.highlights.rename({ text: 'a' });
    expect(runs()).toBe(2);
  });

  it('an expired row does not answer: the replay runs again', async () => {
    await db.insert(idempotencyKeys).values({
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
