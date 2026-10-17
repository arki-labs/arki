/**
 * The pg fast paths (timeout lift in the attempt CTE, merged wait slice, beat ramp) keep the caller's settings and the hold's timeouts.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { createKey } from '../key.js';
import { createLocks } from '../locks.js';
import { pgSession, pgTransaction } from './index.js';

let container: StartedPostgreSqlContainer;
const pools: pg.Pool[] = [];
const swallow = (): null => null;
const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function newPool(options: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10, ...options });
  pool.on('error', swallow);
  pool.on('connect', client => {
    client.on('error', swallow);
  });
  pools.push(pool);
  return pool;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
}, 120_000);

afterAll(async () => {
  await Promise.all(pools.map(pool => pool.end().catch(swallow)));
  await container?.stop();
});

describe('the instant attempt lifts timeouts in its CTE', () => {
  for (const option of [
    'idle_in_transaction_session_timeout=300',
    'transaction_timeout=600',
    'statement_timeout=300',
  ]) {
    it(`tryRun (no wait, CTE path) keeps a 1.2 s hold under ${option}`, async () => {
      const strict = newPool({ options: `-c ${option}` });
      const locks = createLocks({ store: pgSession(drizzle({ client: strict })), namespace: 'rv' });
      const other = createLocks({ store: pgSession(drizzle({ client: newPool() })), namespace: 'rv' });
      const name = `cte-${option.split('=')[0] ?? ''}`;
      const result = await locks.mutex(name).tryRun(async ({ signal }) => {
        await delay(1200);
        const blocked = await other.mutex(name).tryRun(() => 'must not run');
        return { aborted: signal.aborted, blocked };
      });
      expect(result).toMatchObject({ aborted: false, blocked: { code: 'lock.held' } });
    });
  }

  it('the lifted timeouts do not leak into the pool connection after a refused or a finished attempt', async () => {
    const strict = newPool({ max: 1, options: '-c statement_timeout=300 -c idle_in_transaction_session_timeout=400' });
    const strictDb = drizzle({ client: strict });
    const locks = createLocks({ store: pgSession(strictDb), namespace: 'rv' });
    const holder = await orThrow(
      createLocks({ store: pgSession(drizzle({ client: newPool() })), namespace: 'rv' })
        .mutex('leak')
        .acquire({ wait: '1s' }),
    );
    expect(await locks.mutex('leak').tryRun(() => 'no')).toMatchObject({ code: 'lock.held' });
    await holder.release();
    expect(await locks.mutex('leak').tryRun(() => 'yes')).toBe('yes');
    const row = await strictDb.execute<{ st: string; idle: string }>(
      sql`select current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as idle`,
    );
    expect(row.rows[0]).toEqual({ st: '300ms', idle: '400ms' });
  });
});

describe('waitSlice reads the old settings before it sets new ones', () => {
  it("a successful wait in the caller's transaction puts the caller's lock_timeout and statement_timeout back", async () => {
    const dbA = drizzle({ client: newPool() });
    const dbB = drizzle({ client: newPool() });
    const key = createKey('rv', 'slice');
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    let taken!: () => void;
    const hasLock = new Promise<void>(resolve => {
      taken = resolve;
    });
    const holder = dbA.transaction(async tx => {
      await pgTransaction(tx).acquire(key, { token: 'a' });
      taken();
      await released;
    });
    await hasLock;
    setTimeout(release, 300);
    let settings: unknown;
    await dbB.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = 7777`);
      await tx.execute(sql`set local statement_timeout = 8888`);
      expect(await pgTransaction(tx).acquire(key, { token: 'b', waitMs: 3000 })).toBeDefined();
      const row = await tx.execute<{ lt: string; st: string }>(
        sql`select current_setting('lock_timeout') as lt, current_setting('statement_timeout') as st`,
      );
      settings = row.rows[0];
    });
    await holder;
    expect(settings).toEqual({ lt: '7777ms', st: '8888ms' });
  });
});

describe('release latency of a short hold', () => {
  it('releasing right after acquire does not wait out a long beat', async () => {
    const locks = createLocks({ store: pgSession(drizzle({ client: newPool() })), namespace: 'rv' });
    const handle = locks.mutex('latency');
    // Warm the pool.
    await orThrow(handle.tryRun(() => 'warm'));
    const times: number[] = [];
    for (let index = 0; index < 10; index++) {
      const guard = await orThrow(handle.acquire({ wait: '1s' }));
      await delay(5);
      const started = performance.now();
      await guard.release();
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    expect(times[5]).toBeLessThan(60);
  });
});
