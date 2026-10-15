/**
 * pgLease on a real Postgres (container), two pools = two replicas.
 * The database clock is the judge, so "time passing" is done two ways:
 * real sleeping where the test is about real expiry, and shifting `expires_at`
 * back (`shift`) where it only needs the lease to be old.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CaseStore } from '../testing/index.js';
import type { ManualScheduler } from '../testing/manual-scheduler.js';
import type { Duration, Store } from '../types.js';
import type { LeaseDb } from './lease.js';
import { LockError } from '../errors.js';
import { createKey } from '../key.js';
import { createLocks } from '../locks.js';
import { chaos } from '../testing/chaos.js';
import { describeCases, describeStoreContract } from '../testing/index.js';
import { manualScheduler } from '../testing/manual-scheduler.js';
import { replicaCases } from '../testing/replicas.js';
import { parseDuration } from '../wait.js';
import { ensureLockTable, pgLease } from './lease.js';

const TABLE = 'arki_lock_test';
const TTL = '2s';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 8 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 8 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  await ensureLockTable(dbA, TABLE);
}, 120_000);

afterAll(async () => {
  await Promise.all([poolA?.end(), poolB?.end()]);
  await container?.stop();
});

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const lease = (db: NodePgDatabase, ttl: Duration = TTL, table = TABLE) => pgLease(db, { ttl, table });
const leaseWithListen = (db: NodePgDatabase, pool: pg.Pool, table = TABLE) =>
  pgLease(db, { ttl: TTL, table, listen: () => pool.connect() });

/** Make every lease `ms` older, as if the database clock had moved forward. */
async function shift(ms: number, keyFull?: string, table: string = TABLE): Promise<void> {
  const where = keyFull === undefined ? sql`` : sql`WHERE key = ${keyFull}`;
  // One statement: leases age by `expires_at`; semaphore holders keep their own expiry (ms since the epoch) in the row.
  await dbA.execute(
    sql`UPDATE ${sql.identifier(table)} AS l SET expires_at = expires_at - ${ms}::double precision * interval '1 millisecond', holders = CASE WHEN l.holders = '[]'::jsonb THEN l.holders ELSE (SELECT coalesce(jsonb_agg(jsonb_set(h, '{e}', to_jsonb((h->>'e')::double precision - ${ms}::double precision))), '[]'::jsonb) FROM jsonb_array_elements(l.holders) AS h) END ${where}`,
  );
}

/** One manual clock for the manager's timers; each advance also ages the leases in the database. */
function dbBackedScheduler(table: string = TABLE): ManualScheduler {
  const inner = manualScheduler();
  return {
    now: () => inner.now(),
    setTimeout: (cb, ms, opts) => inner.setTimeout(cb, ms, opts),
    clearTimeout: handle => {
      inner.clearTimeout(handle);
    },
    get pendingTimers() {
      return inner.pendingTimers;
    },
    async advance(duration) {
      // Small steps: each ages the leases, then lets the manager's renewals (which reset them) run.
      let left = parseDuration(duration);
      while (left > 0) {
        const step = Math.min(left, 300);
        await shift(step, undefined, table);
        await inner.advance(step);
        left -= step;
      }
    },
  };
}

// --- contract: the same cases every store passes ---------------------------

/**
 * One table and one manual clock per case, so a slow or timed-out case can never age another
 * case's leases. The clock moves only that table's leases.
 */
let tableCounter = 0;
function isolated(build: (table: string) => Store) {
  const make = async (): Promise<CaseStore> => {
    tableCounter += 1;
    const table = `arki_lock_case_${tableCounter}`;
    await ensureLockTable(dbA, table);
    const caseClock = dbBackedScheduler(table);
    return { store: build(table), advanceTime: ms => caseClock.advance(ms), scheduler: caseClock };
  };
  return { make };
}

const poll = isolated(table => lease(dbA, TTL, table));
const wake = isolated(table => leaseWithListen(dbA, poolA, table));

describeStoreContract('pgLease (poll)', poll.make);
describeStoreContract('pgLease (LISTEN/NOTIFY)', wake.make);

// --- chaos hooks the shared suite can drive --------------------------------

const failing = new WeakSet<Store>();
const chaosSuite = isolated(table => flaky(table));
function flaky(table: string): Store {
  const store = lease(dbA, TTL, table);
  const wrapped: Store = {
    ...store,
    extend: (grant, ms) =>
      failing.has(wrapped) ? Promise.resolve(false) : (store.extend?.(grant, ms) ?? Promise.resolve(false)),
  };
  return wrapped;
}
describeCases(
  'pgLease chaos hooks',
  chaos(
    chaosSuite.make,
    {
      // A crashed holder is a lease nobody renews or releases: the key frees after ttl.
      killHolder: () => Promise.resolve(),
      failRenewals: store => {
        failing.add(store);
        return Promise.resolve();
      },
      skewClock: async (_store, ms) => {
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms });
        await sleep(0);
        vi.useRealTimers();
      },
    },
    {},
  ),
);

const replicas = isolated(table => lease(dbA, TTL, table));
describeCases('pgLease replicas', replicaCases(replicas.make, { numRuns: 15 }));

// --- failure bounds, proven against the real database ----------------------

describe('pgLease failure bounds', () => {
  it('blocked renewals: the key frees at ttl, B takes it with generation + 1, and A learns it is lost by renewal', async () => {
    const schedulerA = manualScheduler(); // never advanced while A is "paused"
    const locksA = createLocks({ store: lease(dbA, '1s'), namespace: 'chaos', scheduler: schedulerA });
    const locksB = createLocks({ store: lease(dbB, '1s'), namespace: 'chaos' });
    let markStarted: ((fence: bigint | undefined) => void) | undefined;
    const started = new Promise<bigint | undefined>(resolve => {
      markStarted = resolve;
    });

    const running = locksA.mutex('blocked-renewal').run(
      async ({ signal, fence }) => {
        markStarted?.(fence);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      { wait: '5s' },
    );
    const fenceA = await started;
    expect(fenceA).toBeTypeOf('bigint');

    await sleep(1200); // ttl passes in the database; A's renewal timer never fires
    const taken = await locksB.mutex('blocked-renewal').tryRun(({ fence }) => fence);
    expect(taken).toEqual({ ran: true, value: (fenceA ?? 0n) + 1n });

    await schedulerA.advance(400); // A's first renewal beat: the database answers zero rows
    const error = await running.then(
      () => 'resolved',
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(LockError);
    expect(error).toMatchObject({ code: 'lost', detectedBy: 'renewal' });
  }, 20_000);

  it('the application clock is not consulted: +1 h and -1 h of app skew change nothing', async () => {
    const store = lease(dbA);
    const key = createKey('skew', `k-${Math.random()}`);
    const grant = await store.acquire(key, { token: 'a' });
    expect(grant).toBeDefined();
    for (const skew of [3_600_000, -3_600_000]) {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew });
      try {
        expect(await store.acquire(key, { token: 'b' }), `app clock ${skew} ms off`).toBeUndefined();
        expect(await store.extend?.(grant ?? { key, token: 'a' }, 2000)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('a transaction handle is refused with config before any lock is taken, because a rollback would undo the acquire and repeat the fence', async () => {
    const key = createKey('tx', `refused-${Math.random()}`);
    await dbA.transaction(async tx => {
      const error = await pgLease(tx, { ttl: '1s', table: TABLE })
        .acquire(key, { token: 'a' })
        .then(
          () => 'acquired',
          (error_: unknown) => error_,
        );
      expect(error).toBeInstanceOf(LockError);
      expect(error).toMatchObject({ code: 'config' });
      const rows = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(TABLE)} WHERE key = ${key.full}`,
      );
      expect(rows.rows[0]?.n).toBe(0);
    });
    expect(await lease(dbA).acquire(key, { token: 'b' }), 'a pool handle passes the probe').toMatchObject({
      fence: 1n,
    });
  });

  it('a lease expires on the database clock even while a long transaction elsewhere sees a frozen now(), which is why expiry uses clock_timestamp()', async () => {
    const store = lease(dbA, '1s');
    const key = createKey('tx', `k-${Math.random()}`);
    const longTx = await poolB.connect();
    try {
      await longTx.query('BEGIN');
      await longTx.query('SELECT 1'); // now() freezes here
      const first = await store.acquire(key, { token: 'a' });
      expect(first).toBeDefined();
      await sleep(2100);
      const view = await longTx.query<{ stale: boolean; held_by_now: boolean; held_by_clock: boolean }>(
        `SELECT now() < clock_timestamp() - interval '2 seconds' AS stale,
                expires_at > now() AS held_by_now,
                expires_at > clock_timestamp() AS held_by_clock
           FROM ${TABLE} WHERE key = $1`,
        [key.full],
      );
      expect(view.rows[0], 'premise: by now() the lease would still look held').toEqual({
        stale: true,
        held_by_now: true,
        held_by_clock: false,
      });
      const second = await store.acquire(key, { token: 'b' });
      expect(second?.fence).toBe((first?.fence ?? 0n) + 1n);
    } finally {
      await longTx.query('ROLLBACK');
      longTx.release();
    }
  }, 15_000);
});

describe('ensureLockTable', () => {
  it('replicas booting at once all succeed, because CREATE TABLE IF NOT EXISTS alone races in the catalog', async () => {
    for (let round = 0; round < 5; round++) {
      const table = `arki_lock_boot_${round}_${Math.random().toString(36).slice(2, 8)}`;
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) => ensureLockTable(index % 2 === 0 ? dbA : dbB, table)),
      );
      expect(results.filter(result => result.status === 'rejected')).toEqual([]);
    }
  }, 30_000);
});

// --- the durable fence ------------------------------------------------------

describe('pgLease durable fence', () => {
  it('1000 acquire/lose cycles give strictly increasing generations, because the fence is the only thing a stale writer is checked against', async () => {
    const store = lease(dbA);
    const key = createKey('fence', `cycles-${Math.random()}`);
    let previous = 0n;
    for (let cycle = 0; cycle < 1000; cycle++) {
      const grant = await store.acquire(key, { token: `t${cycle}` });
      expect(grant?.fence, `cycle ${cycle}`).toBeGreaterThan(previous);
      previous = grant?.fence ?? previous;
      if (cycle % 2 === 0) await store.release(grant ?? { key, token: `t${cycle}` });
      else await shift(3_600_000, key.full); // lost: the lease aged out without a release
    }
    expect(previous).toBe(1000n);
  }, 60_000);

  it('release then re-acquire gives generation + 1 and the row survives (would fail with DELETE)', async () => {
    const store = lease(dbA);
    const key = createKey('fence', `release-${Math.random()}`);
    const first = await store.acquire(key, { token: 'a' });
    expect(first?.fence).toBe(1n);
    expect(await store.release(first ?? { key, token: 'a' })).toBe('released');
    const row = await dbA.execute<{ token: string | null; generation: string }>(
      sql`SELECT token, generation::text FROM ${sql.identifier(TABLE)} WHERE key = ${key.full}`,
    );
    expect(row.rows).toEqual([{ token: null, generation: '1' }]);
    const second = await store.acquire(key, { token: 'b' });
    expect(second?.fence).toBe(2n);
  });

  it('two replicas racing for one key: exactly one wins and the generation moves by one', async () => {
    const key = createKey('fence', `race-${Math.random()}`);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => lease(index % 2 === 0 ? dbA : dbB).acquire(key, { token: `r${index}` })),
    );
    const winners = results.filter(grant => grant !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.fence).toBe(1n);
  });
});

// --- LISTEN / NOTIFY --------------------------------------------------------

describe('pgLease LISTEN/NOTIFY wake-up', () => {
  const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> =>
    Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

  it('a waiter wakes when another replica releases, long before any poll would', async () => {
    const waiter = leaseWithListen(dbA, poolA);
    const holder = lease(dbB);
    const key = createKey('listen', `wake-${Math.random()}`);
    const grant = await holder.acquire(key, { token: 'h' });
    const controller = new AbortController();
    try {
      const waiting = waiter.waitFor?.(key, controller.signal) ?? Promise.reject(new Error('no waitFor'));
      expect(await settledWithin(waiting, 300), 'must not wake while the key is held').toBe(false);
      await holder.release(grant ?? { key, token: 'h' });
      expect(await settledWithin(waiting, 1500)).toBe(true);
    } finally {
      controller.abort();
      await waiter.dispose?.();
    }
  });

  it('an aborted wait settles at once, so a cancelled caller never hangs', async () => {
    const waiter = leaseWithListen(dbA, poolA);
    const controller = new AbortController();
    try {
      const waiting =
        waiter.waitFor?.(createKey('listen', 'abort'), controller.signal) ?? Promise.reject(new Error('no waitFor'));
      await sleep(100);
      controller.abort();
      expect(await settledWithin(waiting, 1000)).toBe(true);
    } finally {
      await waiter.dispose?.();
    }
  });

  it('a release while the LISTEN connection is still opening is not missed: the waiter checks the key once listening', async () => {
    const holder = lease(dbB);
    const waiter = pgLease(dbA, {
      ttl: TTL,
      table: TABLE,
      listen: async () => {
        await sleep(300); // a slow handshake: the release lands before LISTEN
        return poolA.connect();
      },
    });
    const key = createKey('listen', `slow-open-${Math.random()}`);
    const grant = await holder.acquire(key, { token: 'h' });
    const controller = new AbortController();
    try {
      const waiting = waiter.waitFor?.(key, controller.signal) ?? Promise.reject(new Error('no waitFor'));
      await sleep(50);
      await holder.release(grant ?? { key, token: 'h' });
      expect(await settledWithin(waiting, 1500)).toBe(true);
    } finally {
      controller.abort();
      await waiter.dispose?.();
    }
  });

  it('many waits hold one LISTEN backend, not one each, so waiters cannot exhaust the pool', async () => {
    const pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 4,
      application_name: 'arki_listen_probe',
    });
    const waiter = pgLease(dbA, { ttl: TTL, table: TABLE, listen: () => pool.connect() });
    const holder = lease(dbB);
    const key = createKey('listen', `one-backend-${Math.random()}`);
    const grant = await holder.acquire(key, { token: 'h' });
    try {
      for (let index = 0; index < 3; index++) {
        const controller = new AbortController();
        const waiting = waiter.waitFor?.(key, controller.signal) ?? Promise.reject(new Error('no waitFor'));
        await sleep(100);
        controller.abort();
        expect(await settledWithin(waiting, 1000)).toBe(true);
      }
      const listening = await dbB.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'arki_listen_probe' AND query = 'LISTEN arki_lock'`,
      );
      expect(listening.rows[0]?.n).toBe(1);
    } finally {
      await waiter.dispose?.();
      await holder.release(grant ?? { key, token: 'h' });
      await pool.end();
    }
  });

  it('a killed LISTEN connection wakes waiters to retry, and the next wait reconnects', async () => {
    const waiter = leaseWithListen(dbA, poolA);
    const holder = lease(dbB);
    const key = createKey('listen', `reconnect-${Math.random()}`);
    const grant = await holder.acquire(key, { token: 'h' });
    const controller = new AbortController();
    try {
      const first = waiter.waitFor?.(key, controller.signal) ?? Promise.reject(new Error('no waitFor'));
      await sleep(200);
      await dbB.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN arki_lock'`);
      expect(await settledWithin(first, 2000)).toBe(true);

      const second = waiter.waitFor?.(key, controller.signal) ?? Promise.reject(new Error('no waitFor'));
      await sleep(200);
      await holder.release(grant ?? { key, token: 'h' });
      expect(await settledWithin(second, 1500)).toBe(true);
    } finally {
      controller.abort();
      await waiter.dispose?.();
    }
  });
});

// --- permits: one row per semaphore key, holders inside it ------------------

const semaphoreKey = (name: string) => createKey('permits', `${name}-${Math.random()}`, 'semaphore');
const request = (token: string, limit: number, weight = 1) => ({ token, limit, weight });

describe('pgLease permits', () => {
  it('two replicas racing 40 weight-1 acquires on a limit of 5 grant exactly 5, because the key row is locked before capacity is read', async () => {
    const storeA = lease(dbA);
    const storeB = lease(dbB);
    const key = semaphoreKey('race');
    const grants = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? storeA : storeB).permits.acquire(key, request(`t${index}`, 5)),
      ),
    );
    const granted = grants.filter(grant => grant !== undefined);
    expect(granted).toHaveLength(5);
    const fences = granted.map(grant => grant.fence);
    expect(new Set(fences).size).toBe(5);
  });

  it('a conflicting limit while live holders exist is a config error; once they drain a new limit is accepted', async () => {
    const store = lease(dbA);
    const key = semaphoreKey('limit');
    const first = await store.permits.acquire(key, request('a', 2));
    expect(first).toBeDefined();
    await expect(store.permits.acquire(key, request('b', 3))).rejects.toMatchObject({ code: 'config' });
    await store.permits.release(first ?? { key, token: 'a' });
    expect(await store.permits.acquire(key, request('c', 3))).toBeDefined();
  });

  it('a crashed holder frees its capacity after the ttl, by the database clock, and the next grant gets a higher fence', async () => {
    const store = lease(dbA, '1s');
    const key = semaphoreKey('crash');
    const lost = await store.permits.acquire(key, request('lost', 1));
    expect(await store.permits.acquire(key, request('early', 1))).toBeUndefined();
    await sleep(1200);
    const next = await store.permits.acquire(key, request('next', 1));
    expect(next?.fence).toBeGreaterThan(lost?.fence ?? 0n);
    // The crashed holder cannot extend or release its way back in.
    expect(await store.permits.extend?.(lost ?? { key, token: 'lost' }, 5000)).toBe(false);
    expect(await store.permits.release(lost ?? { key, token: 'lost' })).toBe('not-owner');
  });

  it('extend keeps a holder alive but never revives an expired one', async () => {
    const store = lease(dbA, '1s');
    const key = semaphoreKey('extend');
    const held = await store.permits.acquire(key, request('held', 1));
    expect(await store.permits.extend?.(held ?? { key, token: 'held' }, 5000)).toBe(true);
    await sleep(1200);
    expect(await store.permits.acquire(key, request('other', 1))).toBeUndefined();
    await store.permits.release(held ?? { key, token: 'held' });
    const short = await store.permits.acquire(key, { ...request('short', 1), ttlMs: 1000 });
    await sleep(1200);
    expect(await store.permits.extend?.(short ?? { key, token: 'short' }, 5000)).toBe(false);
    expect(await store.permits.acquire(key, request('after', 1))).toBeDefined();
  });

  it('release notifies, so a LISTEN waiter on a full semaphore wakes at once', async () => {
    const waiter = leaseWithListen(dbA, poolA);
    const holder = lease(dbB);
    const key = semaphoreKey('wake');
    const grant = await holder.permits.acquire(key, request('h', 1));
    const controller = new AbortController();
    try {
      const startedAt = Date.now();
      const waiting = waiter.waitFor?.(key, controller.signal) ?? Promise.reject(new Error('no waitFor'));
      await sleep(200);
      await holder.permits.release(grant ?? { key, token: 'h' });
      await waiting;
      expect(Date.now() - startedAt).toBeLessThan(1500);
    } finally {
      controller.abort();
      await waiter.dispose?.();
    }
  });

  it('ensureLockTable adds the holders column to a table from before semaphores', async () => {
    await dbA.execute(
      sql`CREATE TABLE IF NOT EXISTS arki_lock_old (key text PRIMARY KEY, token text, generation bigint NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL DEFAULT clock_timestamp(), permits_limit integer)`,
    );
    await Promise.all([ensureLockTable(dbA, 'arki_lock_old'), ensureLockTable(dbB, 'arki_lock_old')]);
    const store = pgLease(dbA, { ttl: TTL, table: 'arki_lock_old' });
    expect(await store.permits.acquire(semaphoreKey('old'), request('a', 1))).toBeDefined();
  });
});

describe('pgLease permits (review proofs)', () => {
  it('R1: a LISTEN waiter whose weight does not fit sleeps until a release, instead of spinning on the database', async () => {
    let statements = 0;
    const counting: LeaseDb = {
      execute: (query: SQL) => {
        statements += 1;
        return dbA.execute(query);
      },
    };
    const waiterStore = pgLease(counting, { ttl: '5s', table: TABLE, listen: () => poolA.connect() });
    const holderStore = pgLease(dbB, { ttl: '5s', table: TABLE });
    const name = `spin-${Math.random()}`;
    // 1 of 2 permits held: a weight-2 waiter cannot fit until it is released.
    const held = await holderStore.permits.acquire(createKey('rev', name, 'semaphore'), {
      token: 'holder',
      limit: 2,
      weight: 1,
    });
    expect(held).toBeDefined();
    const locks = createLocks({ store: waiterStore, namespace: 'rev' });
    try {
      await expect(locks.semaphore(name, { limit: 2 }).run(() => 1, { wait: '1500ms', weight: 2 })).rejects.toThrow();
      // Without a wake-up, a wait of 1.5 s makes a handful of attempts (backoff tops out at 1 s).
      expect(statements).toBeLessThan(40);
    } finally {
      await waiterStore.dispose?.();
    }
  });

  it('R2: ensureLockTable on an up-to-date table does not queue an ACCESS EXCLUSIVE lock that stalls every lease', async () => {
    const store = pgLease(dbA, { ttl: '5s', table: TABLE });
    const reader = await poolB.connect();
    let ensure: Promise<void> | undefined;
    try {
      // Any open transaction that has read the table (a report, pg_dump, a slow query).
      await reader.query('BEGIN');
      await reader.query(`SELECT count(*) FROM ${TABLE}`);
      // A replica boots while that transaction is open. The holders column is already there.
      ensure = ensureLockTable(dbA, TABLE);
      await sleep(300);
      const acquired = store.acquire(createKey('rev', `ddl-${Math.random()}`), { token: 'boot' });
      const outcome = await Promise.race([acquired.then(() => 'acquired'), sleep(1500).then(() => 'stalled')]);
      expect(outcome).toBe('acquired');
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
      await ensure;
    }
  });

  it('R3: mixed weights racing from two replicas never exceed the limit (sanity)', async () => {
    const storeA = pgLease(dbA, { ttl: '5s', table: TABLE });
    const storeB = pgLease(dbB, { ttl: '5s', table: TABLE });
    for (let round = 0; round < 10; round++) {
      const key = createKey('rev', `mixed-${round}-${Math.random()}`, 'semaphore');
      const weights = Array.from({ length: 30 }, (_, index) => (index % 3) + 1);
      const grants = await Promise.all(
        weights.map((weight, index) =>
          (index % 2 === 0 ? storeA : storeB).permits.acquire(key, { token: `t${index}`, limit: 5, weight }),
        ),
      );
      const total = grants.reduce((sum, grant, index) => sum + (grant === undefined ? 0 : (weights[index] ?? 0)), 0);
      expect(total).toBeLessThanOrEqual(5);
      expect(total).toBeGreaterThan(0);
      const fences = grants.flatMap(grant => (grant?.fence === undefined ? [] : [grant.fence]));
      expect(new Set(fences).size).toBe(fences.length);
    }
  });

  it('R4: a limit past int4 is refused as config, not as a raw database error', async () => {
    const store = pgLease(dbA, { ttl: '5s', table: TABLE });
    const key = createKey('rev', `big-${Math.random()}`, 'semaphore');
    await expect(store.permits.acquire(key, { token: 'big', limit: 2 ** 31, weight: 1 })).rejects.toMatchObject({
      code: 'config',
    });
  });
});
