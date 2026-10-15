/**
 * Advisory locks on one session (PGlite): the job's value comes back and the
 * lock is released after — on success and on failure. PGlite has a single
 * connection, so a job here must not query (it would wait for the pinned
 * transaction forever); holding the lock during the job and contention between
 * two sessions are checked on a real server in `lock.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LockableDb } from './lock.js';
import { advisoryLocks, withAdvisoryLock } from './lock.js';
import { initDbRuntimeLocal } from './runtime-local.js';

let client: PGlite;
let db: Awaited<ReturnType<typeof initDbRuntimeLocal<ReturnType<typeof defineRelations>>>>['db'];

beforeAll(async () => {
  ({ db, pglite: client } = await initDbRuntimeLocal({ memory: true }, { relations: defineRelations({}) }));
});

afterAll(async () => {
  await client.close();
});

/** Advisory locks this session holds right now. */
async function heldLocks(): Promise<number> {
  const result = await client.query<{ n: number }>(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and granted",
  );
  return result.rows[0]?.n ?? -1;
}

describe('withAdvisoryLock', () => {
  it('returns the job value and releases the lock after', async () => {
    const run = await withAdvisoryLock(db, 'app:job', async () => 'done');
    expect(run).toEqual({ ran: true, value: 'done' });
    expect(await heldLocks()).toBe(0);
  });

  it('a failing job still releases the lock, and its error reaches the caller', async () => {
    await expect(
      withAdvisoryLock(db, 'app:job', async () => {
        throw new Error('job broke');
      }),
    ).rejects.toThrow('job broke');
    expect(await heldLocks()).toBe(0);
  });

  it('skips the job when another session holds the lock (driver result shapes: rows or a bare array)', async () => {
    let ran = false;
    const job = async () => {
      ran = true;
    };
    // A database whose try-lock says "taken", in both result shapes drivers use.
    for (const result of [{ rows: [{ acquired: false }] }, [{ acquired: false }]]) {
      const taken: LockableDb = { transaction: run => run({ execute: () => Promise.resolve(result) }) };
      expect(await withAdvisoryLock(taken, 'app:job', job)).toEqual({ ran: false });
    }
    expect(ran).toBe(false);
  });

  it('advisoryLocks() puts every key under the app namespace — the key the old withCronLock hashed', async () => {
    const dialect = new PgDialect();
    const params: unknown[] = [];
    const recording: LockableDb = {
      transaction: run =>
        run({
          execute: query => {
            params.push(...dialect.sqlToQuery(query).params);
            return Promise.resolve({ rows: [{ acquired: true }] });
          },
        }),
    };
    await advisoryLocks(recording, { namespace: 'avocabo' }).tryRun('cluster-assign', async () => 'ok');
    // try-lock and unlock both hash the namespaced key.
    expect(params).toEqual(['avocabo:cluster-assign', 'avocabo:cluster-assign']);
  });
});
