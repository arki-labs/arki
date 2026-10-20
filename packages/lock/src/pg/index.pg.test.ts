/**
 * `pgSession` and `pgTransaction` against a real Postgres (container), with two
 * pools standing in for two replicas. These are the cases that need real
 * connections: exclusion across replicas, a killed backend, a killed process,
 * and the two key spaces. SQL shape and the state machine are covered without
 * Docker in `index.test.ts`.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { LockError, LockHeld } from '../errors.js';
import { createKey } from '../key.js';
import { createLocks } from '../locks.js';
import { chaos } from '../testing/chaos.js';
import { describeCases, describeStoreContract } from '../testing/index.js';
import { replicaCases } from '../testing/replicas.js';
import { HOLD_BEAT_SECONDS, pgSession, pgTransaction } from './index.js';

const POOL_SIZE = 40;
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
const extraPools: pg.Pool[] = [];

type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };

function deferred<T = void>(): Deferred<T> {
  const settlers: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>(resolve => {
    settlers.resolve = resolve;
  });
  return { promise, resolve: value => settlers.resolve?.(value) };
}

const swallow = (): null => null;

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function newPool(options: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: POOL_SIZE, ...options });
  // node-postgres emits 'error' on a client whose backend was terminated; without a listener that is an
  // uncaught exception. This is the standard pg setup every app needs, not something a lock store can add.
  pool.on('error', swallow);
  pool.on('connect', client => {
    client.on('error', swallow);
  });
  extraPools.push(pool);
  return pool;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  poolA = newPool();
  poolB = newPool();
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
}, 120_000);

afterAll(async () => {
  await Promise.all(extraPools.map(pool => pool.end().catch(swallow)));
  await container?.stop();
});

async function advisoryCount(db: NodePgDatabase): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`,
  );
  return result.rows[0]?.n ?? -1;
}

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await delay(20);
  }
}

/** Terminate every backend that holds an advisory lock, and wait until Postgres has let go of them. */
async function terminateLockHolders(): Promise<void> {
  await dbB.execute(sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted`);
  await until(async () => (await advisoryCount(dbB)) === 0, 5000, 'terminated backends to release their locks');
}

const lockedNames = (name: string): string => `${name}-${Math.random().toString(36).slice(2)}`;

type Proxy = { readonly url: string; goDark(): void; close(): void };

/**
 * A TCP proxy in front of the container that can go silent: it stops passing
 * bytes both ways but keeps every socket open, like a network partition or a
 * host that vanished (no FIN, no RST). Closing it destroys the sockets.
 */
async function silentProxy(): Promise<Proxy> {
  const sockets = new Set<net.Socket>();
  let dark = false;
  const server = net.createServer(client => {
    const upstream = net.connect(container.getPort(), container.getHost());
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      sockets.add(from);
      from.on('error', swallow);
      from.on('data', (chunk: Buffer) => {
        if (!dark) to.write(chunk);
      });
      from.on('close', () => {
        to.destroy();
      });
    }
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the proxy has no TCP address');
  const url = new URL(container.getConnectionUri());
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url: url.toString(),
    goDark: () => {
      dark = true;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared suites
// ---------------------------------------------------------------------------

// Not run for pgTransaction: one transaction is ONE session, and advisory locks are re-entrant inside a
// session, so a single-transaction store can never refuse a second acquire. Its exclusion is between
// transactions and is tested below.
describeStoreContract('pgSession on Postgres', () => pgSession(dbA));

describe('pgSession chaos and replicas', () => {
  describeCases(
    'chaos',
    chaos(() => pgSession(dbA), {
      killHolder: terminateLockHolders,
      dropConnection: terminateLockHolders,
      // failRenewals / skewClock are not supplied: a hold store renews nothing and has no clock of its own.
    }),
  );
  describeCases(
    'replicas',
    replicaCases(() => pgSession(dbA), { numRuns: 10 }),
  );
});

// ---------------------------------------------------------------------------
// Exclusion and the pool
// ---------------------------------------------------------------------------

describe('pgSession across replicas', () => {
  it('the second replica skips while the first runs, however long, and the job can use the pool meanwhile', async () => {
    const locksA = createLocks({ store: pgSession(dbA), namespace: 'app' });
    const locksB = createLocks({ store: pgSession(dbB), namespace: 'app' });
    const name = lockedNames('digest');
    const started = deferred<number>();
    const finish = deferred<void>();

    const first = locksA.mutex(name).tryRun(async () => {
      started.resolve(await advisoryCount(dbA));
      await finish.promise;
      return 'first';
    });
    expect(await started.promise).toBe(1);

    expect(await locksB.mutex(name).tryRun(() => 'must not run')).toMatchObject({ code: 'lock.held' });
    expect(await locksB.mutex(lockedNames('other')).tryRun(() => 'ran')).toBe('ran');

    finish.resolve();
    expect(await first).toBe('first');
    await until(async () => (await advisoryCount(dbB)) === 0, 2000, 'the lock to be gone after release');
    expect(await locksB.mutex(name).tryRun(() => 'now me')).toBe('now me');
  });

  it('namespaces keep two apps on one server apart', async () => {
    const name = lockedNames('digest');
    const finish = deferred<void>();
    const started = deferred<void>();
    const avocabo = createLocks({ store: pgSession(dbA), namespace: 'avocabo' })
      .mutex(name)
      .tryRun(async () => {
        started.resolve();
        await finish.promise;
      });
    await started.promise;
    expect(
      await createLocks({ store: pgSession(dbB), namespace: 'novelette' })
        .mutex(name)
        .tryRun(() => 'ran'),
    ).toBe('ran');
    finish.resolve();
    expect(await avocabo).toBeUndefined();
  });

  it('a server-side idle-in-transaction timeout does not drop a held lock, because the pinned connection is exempt', async () => {
    const strict = newPool({ options: '-c idle_in_transaction_session_timeout=300' });
    const locks = createLocks({ store: pgSession(drizzle({ client: strict })), namespace: 'app' });
    const other = createLocks({ store: pgSession(dbB), namespace: 'app' });
    const name = lockedNames('idle');
    const finish = deferred<void>();
    const started = deferred<void>();
    const holder = locks.mutex(name).run(
      async ({ signal }) => {
        started.resolve();
        await finish.promise;
        return signal.aborted;
      },
      { wait: '2s' },
    );
    await started.promise;
    await delay(1200);
    expect(await other.mutex(name).tryRun(() => 'must not run')).toMatchObject({ code: 'lock.held' });
    finish.resolve();
    expect(await holder).toBe(false);
  });
});

describe('bounded waits on a real server', () => {
  it('a wait longer than one slice ends in "held" at about its bound, and leaves no lock or pinned connection behind', async () => {
    const locksA = createLocks({ store: pgSession(dbA), namespace: 'app' });
    const locksB = createLocks({ store: pgSession(dbB), namespace: 'app' });
    const name = lockedNames('wait');
    const holder = await orThrow(locksA.mutex(name).acquire({ wait: '2s' }));
    const startedAt = Date.now();
    const error = await locksB
      .mutex(name)
      .run(() => 'never', { wait: '1500ms' })
      .catch((error_: unknown) => error_);
    const took = Date.now() - startedAt;
    expect(LockHeld.is(error)).toBe(true);
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(4000);
    await holder.release();
    await until(async () => (await advisoryCount(dbB)) === 0, 4000, 'the waiter to leave no lock behind');
    expect(await locksB.mutex(name).tryRun(() => 'ok')).toBe('ok');
  });

  it('a waiter gets the lock soon after the holder releases, not after the whole wait', async () => {
    const locksA = createLocks({ store: pgSession(dbA), namespace: 'app' });
    const locksB = createLocks({ store: pgSession(dbB), namespace: 'app' });
    const name = lockedNames('handoff');
    const holder = await orThrow(locksA.mutex(name).acquire({ wait: '2s' }));
    const waiting = locksB.mutex(name).run(() => 'got it', { wait: '10s' });
    await delay(300);
    const releasedAt = Date.now();
    await holder.release();
    expect(await waiting).toBe('got it');
    expect(Date.now() - releasedAt).toBeLessThan(2500);
  });

  it('a caller signal ends the wait at once and a late lock slice does not leak the lock', async () => {
    const locksA = createLocks({ store: pgSession(dbA), namespace: 'app' });
    const locksB = createLocks({ store: pgSession(dbB), namespace: 'app' });
    const name = lockedNames('abort');
    const holder = await orThrow(locksA.mutex(name).acquire({ wait: '2s' }));
    const controller = new AbortController();
    const waiting = locksB
      .mutex(name)
      .run(() => 'never', { signal: controller.signal })
      .catch((error_: unknown) => error_);
    await delay(200);
    controller.abort();
    expect(await waiting).toMatchObject({ code: 'aborted' });
    await holder.release();
    await until(async () => (await advisoryCount(dbB)) === 0, 4000, 'the aborted waiter to leave no lock behind');
  });
});

// ---------------------------------------------------------------------------
// Chaos with real connections
// ---------------------------------------------------------------------------

describe('release speed of a held pgSession lock', () => {
  it('an uncontended tryRun ends in a few ms, far under the longest beat, because release never waits out a long pg_sleep', async () => {
    const locks = createLocks({ store: pgSession(dbA), namespace: 'app' });
    await orThrow(locks.mutex(lockedNames('warm')).tryRun(() => 1));
    const durations: number[] = [];
    for (let i = 0; i < 10; i++) {
      const startedAt = performance.now();
      await orThrow(locks.mutex(lockedNames('fast')).tryRun(() => 1));
      durations.push(performance.now() - startedAt);
    }
    durations.sort((a, b) => a - b);
    expect(durations[5]).toBeLessThan(HOLD_BEAT_SECONDS * 1000);
    expect(durations[5]).toBeLessThan(50);
  });

  it('a blocked waiter gets the lock within a few beats of a release, even when the hold was long', async () => {
    const locksA = createLocks({ store: pgSession(dbA), namespace: 'app' });
    const locksB = createLocks({ store: pgSession(dbB), namespace: 'app' });
    const name = lockedNames('fast-handoff');
    const holder = await orThrow(locksA.mutex(name).acquire({ wait: '2s' }));
    let gotAt = 0;
    const waiting = locksB.mutex(name).run(
      () => {
        gotAt = performance.now();
      },
      { wait: '10s' },
    );
    await delay(500);
    const releasedAt = performance.now();
    await holder.release();
    expect(await waiting).toBeUndefined();
    // The beat in flight at release is at most HOLD_BEAT_SECONDS; the old 200 ms beat plus overhead failed this.
    expect(gotAt - releasedAt).toBeLessThan(HOLD_BEAT_SECONDS * 1000 + 100);
  });
});

describe('chaos: the pinned connection dies', () => {
  it('terminating the holder backend aborts its signal, lets replica B in, and run rejects "lost"', async () => {
    const locksA = createLocks({ store: pgSession(dbA), namespace: 'chaos' });
    const locksB = createLocks({ store: pgSession(dbB), namespace: 'chaos' });
    const name = lockedNames('terminate');
    const started = deferred<void>();
    const aborted = deferred<unknown>();

    const holder = locksA
      .mutex(name)
      .run(
        async ({ signal }) => {
          started.resolve();
          signal.addEventListener('abort', () => {
            aborted.resolve(signal.reason);
          });
          await aborted.promise;
          return 'finished after loss';
        },
        { wait: '2s' },
      )
      .catch((error_: unknown) => error_);
    await started.promise;
    await terminateLockHolders();

    const reason = await Promise.race([aborted.promise, delay(5000).then(() => 'signal never aborted')]);
    expect(reason).toBeInstanceOf(LockError);
    expect(reason).toMatchObject({ code: 'lost', detectedBy: 'connection' });

    expect(await locksB.mutex(name).tryRun(() => 'B in')).toBe('B in');
    const outcome = await holder;
    expect(outcome).toBeInstanceOf(LockError);
    expect(outcome).toMatchObject({ code: 'lost', detectedBy: 'connection' });
  });

  it("the callback's own error survives a dead connection: the failed release never masks it (old bug 5)", async () => {
    const locksA = createLocks({ store: pgSession(dbA), namespace: 'chaos' });
    const name = lockedNames('bug5');
    const boom = new Error('boom from the callback');
    const error = await locksA
      .mutex(name)
      .run(
        async ({ signal }) => {
          const aborted = new Promise<void>(resolve => {
            signal.addEventListener('abort', () => {
              resolve();
            });
          });
          await terminateLockHolders();
          await aborted;
          throw boom;
        },
        { wait: '2s' },
      )
      .catch((error_: unknown) => error_);
    expect(error).toBe(boom);
    expect(error).toMatchObject({ suppressed: [expect.objectContaining({ code: 'lost' })] });
  });

  it('pool.end() mid-callback lets the callback finish and the lock go: the pool waits for its checked-out connection', async () => {
    const pool = newPool();
    const locks = createLocks({ store: pgSession(drizzle({ client: pool })), namespace: 'chaos' });
    const other = createLocks({ store: pgSession(dbB), namespace: 'chaos' });
    const name = lockedNames('pool-end');
    let ending: Promise<void> | undefined;
    const value = await locks.mutex(name).run(
      () => {
        ending = pool.end();
        return 'callback done';
      },
      { wait: '2s' },
    );
    expect(value).toBe('callback done');
    await ending;
    await until(async () => (await advisoryCount(dbB)) === 0, 4000, 'the lock to be gone after the pool ended');
    expect(await other.mutex(name).tryRun(() => 'B in')).toBe('B in');
  });

  it("pool.end() followed by a dead connection still rejects with the callback's own error", async () => {
    const pool = newPool();
    const locks = createLocks({ store: pgSession(drizzle({ client: pool })), namespace: 'chaos' });
    const name = lockedNames('pool-end-boom');
    const boom = new Error('boom after pool.end');
    const error = await locks
      .mutex(name)
      .run(
        async ({ signal }) => {
          const aborted = new Promise<void>(resolve => {
            signal.addEventListener('abort', () => {
              resolve();
            });
          });
          void pool.end();
          await terminateLockHolders();
          await aborted;
          throw boom;
        },
        { wait: '2s' },
      )
      .catch((error_: unknown) => error_);
    expect(error).toBe(boom);
  });

  it('SIGKILL of a process holding a lock frees it in Postgres within 2 s', async () => {
    const name = lockedNames('sigkill');
    const script = `
      import pg from 'pg';
      import { drizzle } from 'drizzle-orm/node-postgres';
      import { createKey } from './src/key.ts';
      import { pgSession } from './src/pg/index.ts';
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      const store = pgSession(drizzle({ client: pool }));
      const grant = await store.acquire(createKey('chaos', process.env.LOCK_NAME), { token: 'child' });
      console.log(grant === undefined ? 'DENIED' : 'READY');
      await new Promise(() => {});
    `;
    const child = spawn('bun', ['-e', script], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri(), LOCK_NAME: name },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes('READY') || text.includes('DENIED')) resolve(text.trim());
      });
      child.on('exit', code => {
        reject(new Error(`child exited early (${String(code)}): ${stderr}`));
      });
    });
    try {
      expect(await ready).toBe('READY');
      expect(await advisoryCount(dbB)).toBe(1);
      child.kill('SIGKILL');
      const killedAt = Date.now();
      await until(
        async () => (await advisoryCount(dbB)) === 0,
        2000,
        'pg_locks to show no advisory lock after SIGKILL',
      );
      expect(Date.now() - killedAt).toBeLessThan(2000);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('chaos: the network goes silent', () => {
  it('a half-open connection (no FIN, no RST) is reported lost within seconds, not when TCP gives up minutes later', async () => {
    const proxy = await silentProxy();
    try {
      const locks = createLocks({
        store: pgSession(drizzle({ client: newPool({ connectionString: proxy.url }) })),
        namespace: 'chaos',
      });
      const started = deferred<void>();
      const aborted = deferred<unknown>();
      const holder = locks
        .mutex(lockedNames('half-open'))
        .run(
          async ({ signal }) => {
            started.resolve();
            signal.addEventListener('abort', () => {
              aborted.resolve(signal.reason);
            });
            await aborted.promise;
            return 'finished after loss';
          },
          { wait: '2s' },
        )
        .catch((error_: unknown) => error_);
      await started.promise;
      proxy.goDark();
      const reason = await Promise.race([aborted.promise, delay(10_000).then(() => 'signal never aborted')]);
      expect(reason).toMatchObject({ code: 'lost', detectedBy: 'connection' });
      expect(await holder).toMatchObject({ code: 'lost' });
    } finally {
      proxy.close();
    }
  });
});

describe('server timeouts set on the role or the pool', () => {
  it('a statement_timeout shorter than a wait slice still waits, and ends in "held" rather than a store error', async () => {
    const strict = newPool({ options: '-c statement_timeout=300' });
    const locks = createLocks({ store: pgSession(drizzle({ client: strict })), namespace: 'app' });
    const name = lockedNames('statement-timeout');
    const holder = await orThrow(
      createLocks({ store: pgSession(dbA), namespace: 'app' })
        .mutex(name)
        .acquire({ wait: '2s' }),
    );
    try {
      const error = await locks
        .mutex(name)
        .run(() => 'never', { wait: '1500ms' })
        .catch((error_: unknown) => error_);
      expect(LockHeld.is(error)).toBe(true);
    } finally {
      await holder.release();
    }
  });

  it('a transaction_timeout (Postgres 17) does not end a held lock: the pinned transaction is exempt, like the idle timeout', async () => {
    const strict = newPool({ options: '-c transaction_timeout=600' });
    const locks = createLocks({ store: pgSession(drizzle({ client: strict })), namespace: 'app' });
    const other = createLocks({ store: pgSession(dbB), namespace: 'app' });
    const name = lockedNames('transaction-timeout');
    const aborted = await locks.mutex(name).run(
      async ({ signal }) => {
        await delay(1200);
        expect(await other.mutex(name).tryRun(() => 'must not run')).toMatchObject({ code: 'lock.held' });
        return signal.aborted;
      },
      { wait: '2s' },
    );
    expect(aborted).toBe(false);
  });

  it('a wait counts the time spent queueing for a pool connection, so a starved pool cannot stretch it', async () => {
    const tiny = newPool({ max: 1 });
    const locks = createLocks({ store: pgSession(drizzle({ client: tiny })), namespace: 'app' });
    const name = lockedNames('pool-queue');
    const holder = await orThrow(
      createLocks({ store: pgSession(dbA), namespace: 'app' })
        .mutex(name)
        .acquire({ wait: '2s' }),
    );
    const busy = await tiny.connect();
    try {
      const startedAt = Date.now();
      const waiting = locks
        .mutex(name)
        .run(() => 'never', { wait: '1000ms' })
        .catch((error_: unknown) => error_);
      await delay(1500);
      busy.release();
      expect(LockHeld.is(await waiting)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2200);
    } finally {
      await holder.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Key spaces
// ---------------------------------------------------------------------------

describe('legacyKeys during a rolling deploy', () => {
  async function holds(storeA: ReturnType<typeof pgSession>, storeB: ReturnType<typeof pgSession>): Promise<boolean> {
    const name = lockedNames('legacy');
    const first = await orThrow(
      createLocks({ store: storeA, namespace: 'avocabo' }).mutex(name).acquire({ wait: '2s' }),
    );
    try {
      const second = await createLocks({ store: storeB, namespace: 'avocabo' })
        .mutex(name)
        .tryRun(() => 'ran');
      return LockHeld.is(second);
    } finally {
      await first.release();
    }
  }

  it('both on legacyKeys exclude each other', async () => {
    expect(await holds(pgSession(dbA, { legacyKeys: true }), pgSession(dbB, { legacyKeys: true }))).toBe(true);
  });

  it('both on the default keys exclude each other', async () => {
    expect(await holds(pgSession(dbA), pgSession(dbB))).toBe(true);
  });

  it('legacyKeys on one replica and the default on the other do NOT exclude each other (different key spaces; switch all replicas together)', async () => {
    expect(await holds(pgSession(dbA, { legacyKeys: true }), pgSession(dbB))).toBe(false);
    expect(await holds(pgSession(dbA), pgSession(dbB, { legacyKeys: true }))).toBe(false);
  });

  it('legacyKeys excludes the old withAdvisoryLock, which holds a session lock on hashtext("<namespace>:<key>")', async () => {
    const name = lockedNames('old-code');
    const oldReplica = await poolB.connect();
    try {
      const old = await oldReplica.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock(hashtext('avocabo:${name}')) as acquired`,
      );
      expect(old.rows[0]?.acquired).toBe(true);
      const result = await createLocks({ store: pgSession(dbA, { legacyKeys: true }), namespace: 'avocabo' })
        .mutex(name)
        .tryRun(() => 'must not run');
      expect(result).toMatchObject({ code: 'lock.held' });
    } finally {
      await oldReplica.query(`select pg_advisory_unlock_all()`);
      oldReplica.release();
    }
  });
});

const rwKey = (name: string) => createKey('rw', lockedNames(name), 'readWrite');

describe('pgSession read/write across replicas', () => {
  const take = (
    store: ReturnType<typeof pgSession>,
    key: ReturnType<typeof rwKey>,
    token: string,
    mode: 'read' | 'write',
    waitMs?: number,
  ) => store.shared.acquire(key, { token, mode, waitMs });

  it('readers on two replicas overlap, and a writer on a third connection waits for both', async () => {
    const storeA = pgSession(dbA);
    const storeB = pgSession(dbB);
    const key = rwKey('overlap');
    const readerA = await take(storeA, key, 'ra', 'read');
    const readerB = await take(storeB, key, 'rb', 'read');
    expect(readerA).toBeDefined();
    expect(readerB).toBeDefined();
    expect(await take(storeA, key, 'w0', 'write')).toBeUndefined();

    const waiting = take(storeB, key, 'w1', 'write', 5000);
    await new Promise(resolve => setTimeout(resolve, 300));
    await storeA.shared.release(readerA ?? { key, token: 'ra' });
    await new Promise(resolve => setTimeout(resolve, 300));
    // One reader is still in: the writer has not been granted.
    expect(await Promise.race([waiting.then(() => 'granted'), Promise.resolve('pending')])).toBe('pending');
    await storeB.shared.release(readerB ?? { key, token: 'rb' });
    const writer = await waiting;
    expect(writer).toBeDefined();
    await storeB.shared.release(writer ?? { key, token: 'w1' });
    await Promise.all([storeA.dispose?.(), storeB.dispose?.()]);
  });

  it('read/write keys do not collide with mutex keys of the same name', async () => {
    const store = pgSession(dbA);
    const other = pgSession(dbB);
    const name = lockedNames('collide');
    const mutex = await store.acquire(createKey('rw', name), { token: 'm' });
    const writer = await take(other, createKey('rw', name, 'readWrite'), 'w', 'write');
    expect(mutex).toBeDefined();
    expect(writer).toBeDefined();
    await store.release(mutex ?? { key: createKey('rw', name), token: 'm' });
    await other.shared.release(writer ?? { key: createKey('rw', name, 'readWrite'), token: 'w' });
  });

  it('pgTransaction: a reader and a writer in different transactions exclude, and read-then-write inside one transaction is granted', async () => {
    const key = rwKey('tx');
    await dbA.transaction(async txA => {
      const a = pgTransaction(txA);
      expect(await a.shared.acquire(key, { token: 'r', mode: 'read' })).toBeDefined();
      // Same session: Postgres lets it take the write lock too (no upgrade check).
      expect(await a.shared.acquire(key, { token: 'w', mode: 'write' })).toBeDefined();
      await dbB.transaction(async txB => {
        const b = pgTransaction(txB);
        expect(await b.shared.acquire(key, { token: 'x', mode: 'read' })).toBeUndefined();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// pgTransaction
// ---------------------------------------------------------------------------

describe('pgTransaction between transactions', () => {
  const key = createKey('tx', 'job');

  /** Run `body` inside one transaction on `db`; the transaction ends when `body` does. */
  async function inTransaction(
    db: NodePgDatabase,
    body: (store: ReturnType<typeof pgTransaction>) => Promise<void>,
  ): Promise<void> {
    await db.transaction(async tx => {
      await body(pgTransaction(tx));
    });
  }

  it('a lock held by one transaction excludes another, and COMMIT frees it', async () => {
    const holderHasLock = deferred<void>();
    const commit = deferred<void>();
    const holder = inTransaction(dbA, async store => {
      expect(await store.acquire(key, { token: 'a' })).toBeDefined();
      holderHasLock.resolve();
      await commit.promise;
    });
    await holderHasLock.promise;
    await inTransaction(dbB, async store => {
      expect(await store.acquire(key, { token: 'b' })).toBeUndefined();
    });
    commit.resolve();
    await holder;
    await inTransaction(dbB, async store => {
      expect(await store.acquire(key, { token: 'b2' })).toBeDefined();
    });
  });

  it('ROLLBACK frees the lock too', async () => {
    const holderHasLock = deferred<void>();
    const fail = deferred<void>();
    const holder = inTransaction(dbA, async store => {
      await store.acquire(key, { token: 'a' });
      holderHasLock.resolve();
      await fail.promise;
      throw new Error('abort this transaction');
    }).catch(swallow);
    await holderHasLock.promise;
    fail.resolve();
    await holder;
    await inTransaction(dbB, async store => {
      expect(await store.acquire(key, { token: 'b' })).toBeDefined();
    });
  });

  it("a timed-out wait leaves the caller's transaction usable, and a later wait gets the lock", async () => {
    const holderHasLock = deferred<void>();
    const commit = deferred<void>();
    const holder = inTransaction(dbA, async store => {
      await store.acquire(key, { token: 'a' });
      holderHasLock.resolve();
      await commit.promise;
    });
    await holderHasLock.promise;
    await dbB.transaction(async tx => {
      const store = pgTransaction(tx);
      expect(await store.acquire(key, { token: 'b1', waitMs: 1300 })).toBeUndefined();
      // Not poisoned: ordinary statements still work, and lock_timeout is back to the caller's value.
      const setting = await tx.execute<{ value: string }>(sql`select current_setting('lock_timeout') as value`);
      expect(setting.rows[0]?.value).toBe('0');
      commit.resolve();
      expect(await store.acquire(key, { token: 'b2', waitMs: 5000 })).toBeDefined();
    });
    await holder;
  });

  it('a caller statement_timeout shorter than a slice ends the wait as not acquired, and the caller keeps its timeout and a usable transaction', async () => {
    const holderHasLock = deferred<void>();
    const commit = deferred<void>();
    const holder = inTransaction(dbA, async store => {
      await store.acquire(key, { token: 'a' });
      holderHasLock.resolve();
      await commit.promise;
    });
    await holderHasLock.promise;
    try {
      await dbB.transaction(async tx => {
        await tx.execute(sql`set local statement_timeout = 300`);
        expect(await pgTransaction(tx).acquire(key, { token: 'b', waitMs: 1300 })).toBeUndefined();
        const setting = await tx.execute<{ value: string }>(sql`select current_setting('statement_timeout') as value`);
        expect(setting.rows[0]?.value).toBe('300ms');
      });
    } finally {
      commit.resolve();
      await holder;
    }
  });

  it('a lock taken through a savepoint handle ends when that savepoint rolls back, before the outer COMMIT', async () => {
    const name = createKey('tx', lockedNames('savepoint'));
    await dbA.transaction(async outer => {
      await outer
        .transaction(async savepoint => {
          expect(await pgTransaction(savepoint).acquire(name, { token: 'a' })).toBeDefined();
          throw new Error('roll back to the savepoint');
        })
        .catch(swallow);
      await inTransaction(dbB, async store => {
        expect(await store.acquire(name, { token: 'b' })).toBeDefined();
      });
    });
  });

  // Without the core waiting for the store, the caller's next statement landed in the aborted savepoint (25P02).
  it("an aborted wait hands the caller's transaction back only once the store is done with it, so the caller's next statement works", async () => {
    const name = lockedNames('abort-tx');
    const holder = await orThrow(
      createLocks({ store: pgSession(dbA), namespace: 'tx' })
        .mutex(name)
        .acquire({ wait: '2s' }),
    );
    try {
      await dbB.transaction(async tx => {
        const controller = new AbortController();
        const waiting = createLocks({ store: pgTransaction(tx), namespace: 'tx' })
          .mutex(name)
          .run(() => 'never', { wait: '5s', signal: controller.signal })
          .catch((error_: unknown) => error_);
        await delay(200);
        controller.abort();
        expect(await waiting).toMatchObject({ code: 'aborted' });
        const after = await tx.execute<{ one: number }>(sql`select 1 as one`);
        expect(after.rows[0]?.one).toBe(1);
      });
    } finally {
      await holder.release();
    }
  });
});
