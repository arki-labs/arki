// Speed of @arki/lock against the lock libraries most projects use.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Redis 7 and Postgres 17 run in local Docker containers (loopback). Every
// library gets the same keys, the same connection (or pool), the same lease
// length (30 s), the same 10 ms retry gap for competitors that poll (ours back off up to 1 s), the same
// critical section and the same release. Each `compare` group states a contract
// that is checked before timing, for our store and for every competitor:
// never more than `limit` callers inside at once (measured inside the section),
// an exclusion probe with a 3 ms section, and a clean backend afterwards.
// A library that breaks the contract fails the group; nothing is dropped or relaxed.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Mutex as AsyncMutex, Semaphore as AsyncSemaphore } from 'async-mutex';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Redis } from 'ioredis';
import pLimit from 'p-limit';
import pg from 'pg';
import { createAdvisoryLockManager } from 'pg-advisory-lock';
import postgres from 'postgres';
import lockfile from 'proper-lockfile';
import { Mutex as RedisMutex, Semaphore as RedisSemaphore } from 'redis-semaphore';
import { createLock, IoredisAdapter } from 'redlock-universal';
import { GenericContainer } from 'testcontainers';

import type { CaseSpec, MetricSpec } from '@arki/bench';
import { compare, defineSuite, metric } from '@arki/bench';
import { createLocks } from '@arki/lock';
import { fileStore } from '@arki/lock/file';
import { memoryStore } from '@arki/lock/memory';
import { pgSession, pgTransaction } from '@arki/lock/pg';
import { ensureLockTable, pgLease } from '@arki/lock/pg/lease';
import { redisStore } from '@arki/lock/redis';

import type { Backend, Impl, ImplState, Outcome, Runner } from './harness.js';
import {
  expectedFor,
  finish,
  handoffGaps,
  judge,
  newState,
  percentile,
  runConcurrent,
  runSequential,
  spin,
} from './harness.js';

// ---------------------------------------------------------------------------
// Infrastructure: started once per measuring process, with top-level await
// (`setup` of a case is synchronous). The containers are removed by the
// testcontainers reaper when the process ends.
// ---------------------------------------------------------------------------

// The reaper (Ryuk) is what removes the containers: a bench worker ends with process.exit, so no hook can stop them.
// eslint-disable-next-line turbo/no-undeclared-env-vars -- read only to refuse to run without the reaper
if (process.env['TESTCONTAINERS_RYUK_DISABLED'] !== undefined) {
  throw new Error(
    'TESTCONTAINERS_RYUK_DISABLED is set: the bench containers would never be removed. Unset it, then run again.',
  );
}

const [redisContainer, postgresContainer] = await Promise.all([
  new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  new PostgreSqlContainer('postgres:17-alpine').start(),
]);

const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
const redis = new Redis(redisUrl);
function ignoreNotice(): void {
  // "already exists, skipping" notices from CREATE TABLE IF NOT EXISTS are not results.
}
const pgUri = postgresContainer.getConnectionUri();
// A waiting advisory-lock caller holds one connection, so the pool is larger than the biggest caller count.
const pgClient = postgres(pgUri, { max: 60, onnotice: ignoreNotice });
const db = drizzle({ client: pgClient });
const listenPool = new pg.Pool({ connectionString: pgUri, max: 4 });

const LEASE_TABLE = 'bench_lease';
await ensureLockTable(db, LEASE_TABLE);
await db.execute(
  sql`CREATE TABLE IF NOT EXISTS bench_raw_lease (key text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL)`,
);

// Same for everyone.
const LEASE_MS = 30_000;
const WAIT = '30s';
const RETRY_MS = 10;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The rows of a Drizzle `execute` result: a bare array (postgres.js) or `{ rows }`. */
function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  const rows: unknown = Array.isArray(result) ? result : isRecord(result) ? result['rows'] : undefined;
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => isRecord(row)) : [];
}

function numberAt(result: unknown, column: string): number {
  return Number(rowsOf(result)[0]?.[column] ?? Number.NaN);
}

function booleanAt(result: unknown, column: string): boolean {
  return rowsOf(result)[0]?.[column] === true;
}

const noop = (): Promise<void> => Promise.resolve();
const nothing = (): void => undefined;

/** One shared object per name while it has users: how a caller uses a library that has no keys of its own. */
function keyed<T>(
  make: () => T,
  use: (item: T, section: () => Promise<void>) => Promise<void>,
): { readonly runner: Runner; size(): number; has(name: string): boolean } {
  const items = new Map<string, { readonly item: T; users: number }>();
  const runner: Runner = (name, section) => {
    let entry = items.get(name);
    if (entry === undefined) {
      entry = { item: make(), users: 0 };
      items.set(name, entry);
    }
    entry.users += 1;
    const current = entry;
    return use(current.item, section).finally(() => {
      current.users -= 1;
      if (current.users === 0) items.delete(name);
    });
  };
  return { runner, size: () => items.size, has: name => items.has(name) };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function keyedImpl(
  limit: number,
  shared: { readonly runner: Runner; size(): number; has(name: string): boolean },
): Impl {
  const left = (): Promise<readonly string[]> =>
    Promise.resolve(shared.size() === 0 ? [] : [`${shared.size()} keys still tracked in memory`]);
  const backend: Backend = {
    problems: left,
    held: name => Promise.resolve(shared.has(name)),
    sweep: left,
  };
  return { runner: shared.runner, backend, limit, dispose: noop };
}

/**
 * The key `@arki/lock` builds for `name`, in the encoding its key.ts documents
 * (`1:<len>:<ns>:<len>:<name>` for a mutex, `1s:` for a semaphore). `createKey` is not exported,
 * and `memoryStore().peek(key)` reads the store's own table by `key.full`.
 */
function memoryKey(
  name: string,
  limit: number,
): { readonly namespace: string; readonly name: string; readonly full: string } {
  const namespace = 'bench';
  const tag = limit === 1 ? '1' : '1s';
  return { namespace, name, full: `${tag}:${namespace.length}:${namespace}:${name.length}:${name}` };
}

const arkiMemory = (limit: number): Impl => {
  const store = memoryStore();
  const locks = createLocks({ store, namespace: 'bench' });
  const runner: Runner =
    limit === 1
      ? (name, section) => locks.mutex(name).run(section)
      : (name, section) => locks.semaphore(name, { limit }).run(section);
  // Read the store's own table (`peek`), not the lock API: a held key has an entry, a free key has none.
  const heldNow = (name: string): boolean => store.peek(memoryKey(name, limit)) !== undefined;
  const left = (names: readonly string[]): readonly string[] =>
    names.filter(name => heldNow(name)).map(name => `${name} is still held in the memory store`);
  const backend: Backend = {
    problems: name => Promise.resolve(left([name])),
    held: name => Promise.resolve(heldNow(name)),
    sweep: (_prefix, recent) => Promise.resolve(left(recent)),
  };
  return { runner, backend, limit, dispose: noop };
};

const asyncMutexImpl = (): Impl =>
  keyedImpl(
    1,
    keyed(
      () => new AsyncMutex(),
      (mutex, section) => mutex.runExclusive(section),
    ),
  );
const pLimitImpl = (limit: number): Impl =>
  keyedImpl(
    limit,
    keyed(
      () => pLimit(limit),
      (queue, section) => queue(section),
    ),
  );
const asyncSemaphoreImpl = (limit: number): Impl =>
  keyedImpl(
    limit,
    keyed(
      () => new AsyncSemaphore(limit),
      (semaphore, section) => semaphore.runExclusive(section),
    ),
  );

/** A promise chain per name: the least anyone would write by hand. */
const chainImpl = (): Impl => {
  const tails = new Map<string, Promise<void>>();
  const runner: Runner = (name, section) => {
    const previous = tails.get(name) ?? Promise.resolve();
    const run = previous.then(section);
    const done = run.then(noop, noop);
    tails.set(name, done);
    // Forget the name before the caller's promise settles, so "nothing is left" can be checked right after.
    return run.finally(() => {
      if (tails.get(name) === done) tails.delete(name);
    });
  };
  const left = (): Promise<readonly string[]> =>
    Promise.resolve(tails.size === 0 ? [] : [`${tails.size} chains still tracked`]);
  return { runner, backend: { problems: left, sweep: left }, limit: 1, dispose: noop };
};

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/** Runs a Lua script by its SHA, loading it on the first NOSCRIPT. One round trip, like every library here. */
function luaScript(source: string): (keys: readonly string[], args: readonly (string | number)[]) => Promise<unknown> {
  const sha = createHash('sha1').update(source).digest('hex');
  return async (keys, args) => {
    try {
      return await redis.evalsha(sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
      await redis.script('LOAD', source);
      return redis.evalsha(sha, keys.length, ...keys, ...args);
    }
  };
}

const unlockIfOwner = luaScript(
  `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
);
const takePermit = luaScript(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0`);

/** Our fence counter is durable on purpose (a fence must never go back), so it is not a held lock. */
const isFenceCounter = (key: string): boolean => key.endsWith(':fence');

async function keysMatching(part: string): Promise<readonly string[]> {
  return redis.keys(`*${part}*`);
}

const redisBackend: Backend = {
  problems: async name => {
    const keys = await keysMatching(name);
    return keys.filter(key => !isFenceCounter(key)).map(key => `redis key ${key} is left`);
  },
  held: async name => {
    const keys = await keysMatching(name);
    return keys.some(key => !isFenceCounter(key));
  },
  ttlMs: async name => {
    let longest = 0;
    for (const key of await keysMatching(name)) longest = Math.max(longest, await redis.pttl(key));
    return longest;
  },
  sweep: async prefix => {
    const keys = await keysMatching(prefix);
    for (let start = 0; start < keys.length; start += 1000) await redis.unlink(...keys.slice(start, start + 1000));
    return keys.filter(key => !isFenceCounter(key)).map(key => `redis key ${key} is left`);
  },
};

const redisImpl = (limit: number, runner: Runner, dispose: () => Promise<void> = noop): Impl => ({
  runner,
  backend: redisBackend,
  limit,
  dispose,
});

const arkiRedis = (limit: number, wake: 'pubsub' | 'poll' = 'pubsub'): Impl => {
  const store = redisStore(redis, { ttl: '30s', wake });
  const locks = createLocks({ store, namespace: 'bench' });
  const runner: Runner =
    limit === 1
      ? (name, section) => locks.mutex(name).run(section, { wait: WAIT })
      : (name, section) => locks.semaphore(name, { limit }).run(section, { wait: WAIT });
  return redisImpl(limit, runner, async () => store.dispose?.());
};

const redisSemaphoreMutexImpl = (refreshIntervalMs?: number): Impl =>
  redisImpl(1, async (name, section) => {
    const mutex = new RedisMutex(redis, name, {
      lockTimeout: LEASE_MS,
      acquireTimeout: LEASE_MS,
      retryInterval: RETRY_MS,
      ...(refreshIntervalMs === undefined ? {} : { refreshInterval: refreshIntervalMs }),
    });
    await mutex.acquire();
    try {
      await section();
    } finally {
      await mutex.release();
    }
  });

const redisSemaphoreImpl = (limit: number): Impl =>
  redisImpl(limit, async (name, section) => {
    const semaphore = new RedisSemaphore(redis, name, limit, {
      lockTimeout: LEASE_MS,
      acquireTimeout: LEASE_MS,
      retryInterval: RETRY_MS,
    });
    await semaphore.acquire();
    try {
      await section();
    } finally {
      await semaphore.release();
    }
  });

const redlockUniversalImpl = (): Impl => {
  const adapter = new IoredisAdapter(redis);
  // Its default is 3 tries: under contention that gives up. Same 10 ms gap as the others, for the full wait.
  return redisImpl(1, async (name, section) => {
    const lock = createLock({ adapter, key: name, ttl: LEASE_MS, retryAttempts: 3000, retryDelay: RETRY_MS });
    await lock.using(section);
  });
};

/** Raw ioredis: `SET NX PX`, then compare-and-delete in Lua. Spins every 10 ms when it must wait. */
const rawRedisImpl = (): Impl =>
  redisImpl(1, async (name, section) => {
    const token = randomUUID();
    await spin(async () => (await redis.set(name, token, 'PX', LEASE_MS, 'NX')) === 'OK', RETRY_MS);
    try {
      await section();
    } finally {
      await unlockIfOwner([name], [token]);
    }
  });

/** Raw ioredis semaphore: a ZSET of holders scored by expiry, one Lua step to take a permit, ZREM to give it back. */
const rawRedisSemaphoreImpl = (limit: number): Impl =>
  redisImpl(limit, async (name, section) => {
    const token = randomUUID();
    await spin(async () => (await takePermit([name], [token, limit, LEASE_MS])) === 1, RETRY_MS);
    try {
      await section();
    } finally {
      await redis.zrem(name, token);
    }
  });

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

const advisoryKey = (name: string) => sql`hashtextextended(${name}, 0)`;

const advisoryBackend: Backend = {
  problems: async () => {
    const count = numberAt(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`),
      'n',
    );
    return count === 0 ? [] : [`${count} advisory locks are still in pg_locks`];
  },
  // From a separate connection (the pg pool), so it sees what the lock holder's session really holds.
  held: async () => {
    const result = await listenPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
    );
    return (result.rows[0]?.n ?? 0) > 0;
  },
  sweep: async () => advisoryBackend.problems(''),
};

const pgImpl = (runner: Runner, options: { mayskip?: boolean; dispose?: () => Promise<void> } = {}): Impl => ({
  runner,
  backend: advisoryBackend,
  limit: 1,
  ...(options.mayskip === true ? { mayskip: true } : {}),
  dispose: options.dispose ?? noop,
});

const arkiAdvisory = (): Impl => {
  const locks = createLocks({ store: pgSession(db), namespace: 'bench' });
  return pgImpl((name, section) => locks.mutex(name).run(section, { wait: WAIT }), {
    dispose: () => locks.store.dispose?.() ?? Promise.resolve(),
  });
};

const arkiAdvisoryTry = (): Impl => {
  const locks = createLocks({ store: pgSession(db), namespace: 'bench' });
  return pgImpl(
    async (name, section) => {
      await locks.mutex(name).tryRun(section);
    },
    { mayskip: true, dispose: () => locks.store.dispose?.() ?? Promise.resolve() },
  );
};

const pgAdvisoryLockPackage = (kind: 'wait' | 'try'): Impl => {
  const manager = createAdvisoryLockManager(pgClient);
  const runner: Runner =
    kind === 'wait'
      ? async (name, section) => {
          await manager.withLock(name, section);
        }
      : async (name, section) => {
          await manager.tryWithLock(name, section);
        };
  return pgImpl(runner, { mayskip: kind === 'try', dispose: () => manager.close() });
};

/** Raw SQL, the same four statements the session store sends: BEGIN, try-lock, unlock, COMMIT. */
const rawAdvisoryTry = (): Impl =>
  pgImpl(
    async (name, section) => {
      await db.transaction(async tx => {
        if (
          !booleanAt(await tx.execute(sql`SELECT pg_try_advisory_lock(${advisoryKey(name)}) AS acquired`), 'acquired')
        )
          return;
        try {
          await section();
        } finally {
          await tx.execute(sql`SELECT pg_advisory_unlock(${advisoryKey(name)})`);
        }
      });
    },
    { mayskip: true },
  );

/** The cheapest hand-written path: a reserved connection, try-lock, unlock. Two statements. */
const rawAdvisoryTryReserved = (): Impl =>
  pgImpl(
    async (name, section) => {
      const connection = await pgClient.reserve();
      try {
        const rows = await connection`SELECT pg_try_advisory_lock(hashtextextended(${name}, 0)) AS acquired`;
        if (rows[0]?.['acquired'] !== true) return;
        try {
          await section();
        } finally {
          await connection`SELECT pg_advisory_unlock(hashtextextended(${name}, 0))`;
        }
      } finally {
        connection.release();
      }
    },
    { mayskip: true },
  );

/** Raw SQL that waits inside Postgres: BEGIN, `pg_advisory_lock`, unlock, COMMIT. */
const rawAdvisoryWait = (): Impl =>
  pgImpl(async (name, section) => {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_lock(${advisoryKey(name)})`);
      try {
        await section();
      } finally {
        await tx.execute(sql`SELECT pg_advisory_unlock(${advisoryKey(name)})`);
      }
    });
  });

const arkiXact = (): Impl =>
  pgImpl(async (name, section) => {
    await db.transaction(async tx => {
      const locks = createLocks({ store: pgTransaction(tx), namespace: 'bench' });
      await locks.mutex(name).run(section, { wait: WAIT });
    });
  });

const rawXact = (): Impl =>
  pgImpl(async (name, section) => {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey(name)})`);
      await section();
    });
  });

/** A lease table has no pg_locks to read: look for rows that still hold a live lease. */
function leaseBackend(table: 'bench_lease' | 'bench_raw_lease'): Backend {
  const live =
    table === 'bench_lease'
      ? sql`(token IS NOT NULL AND expires_at > clock_timestamp())`
      : sql`(expires_at > clock_timestamp())`;
  const from = sql.raw(table);
  const count = async (part: string): Promise<number> =>
    numberAt(
      await db.execute(sql`SELECT count(*)::int AS n FROM ${from} WHERE position(${part} in key) > 0 AND ${live}`),
      'n',
    );
  return {
    problems: async name => {
      const rows = await count(name);
      return rows === 0 ? [] : [`${rows} live rows are left in ${table}`];
    },
    held: async name => (await count(name)) > 0,
    ttlMs: async name =>
      numberAt(
        await db.execute(
          sql`SELECT coalesce(max(extract(epoch FROM (expires_at - clock_timestamp())) * 1000), 0)::float8 AS ttl FROM ${from} WHERE position(${name} in key) > 0 AND ${live}`,
        ),
        'ttl',
      ),
    sweep: async prefix => {
      const left = await count(prefix);
      await db.execute(sql`DELETE FROM ${from} WHERE position(${prefix} in key) > 0`);
      return left === 0 ? [] : [`${left} live rows are left in ${table}`];
    },
  };
}

const arkiLease = (listen: boolean): Impl => {
  const store = listen
    ? pgLease(db, { ttl: '30s', table: LEASE_TABLE, listen: () => listenPool.connect() })
    : pgLease(db, { ttl: '30s', table: LEASE_TABLE });
  const locks = createLocks({ store, namespace: 'bench' });
  return {
    runner: (name, section) => locks.mutex(name).run(section, { wait: WAIT }),
    backend: leaseBackend('bench_lease'),
    limit: 1,
    dispose: () => store.dispose?.() ?? Promise.resolve(),
  };
};

/** Raw SQL: one upsert takes the lease when it is free or expired, one DELETE gives it back. Spins every 10 ms. */
const rawLease = (): Impl => ({
  runner: async (name, section) => {
    const token = randomUUID();
    await spin(
      async () =>
        rowsOf(
          await db.execute(sql`
            INSERT INTO bench_raw_lease AS l (key, token, expires_at)
            VALUES (${name}, ${token}, clock_timestamp() + ${LEASE_MS}::double precision * interval '1 millisecond')
            ON CONFLICT (key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
              WHERE l.expires_at <= clock_timestamp()
            RETURNING l.token
          `),
        ).length > 0,
      RETRY_MS,
    );
    try {
      await section();
    } finally {
      await db.execute(sql`DELETE FROM bench_raw_lease WHERE key = ${name} AND token = ${token}`);
    }
  },
  backend: leaseBackend('bench_raw_lease'),
  limit: 1,
  dispose: noop,
});

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

function fileBackend(root: string): Backend {
  const left = async (): Promise<readonly string[]> => {
    const entries = await readdir(root);
    return entries.length === 0
      ? []
      : [`${entries.length} entries are left in the lock directory: ${entries.slice(0, 3).join(', ')}`];
  };
  // The lock is a directory entry: it must exist on disk while held.
  const held = async (): Promise<boolean> => {
    const entries = await readdir(root);
    return entries.length > 0;
  };
  return { problems: left, held, sweep: left };
}

/** Each file implementation locks inside its own empty directory. */
async function fileRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'arki-lock-bench-'));
}

// `setup` is synchronous, so the directory is made on first use and removed in dispose.
function lazyRoot(): { root(): Promise<string>; peek(): string | undefined } {
  let pending: Promise<string> | undefined;
  let made: string | undefined;
  return {
    root: () => (pending ??= fileRoot().then(created => (made = created))),
    peek: () => made,
  };
}

function fileImpl(build: (root: string) => Runner): Impl {
  const lazy = lazyRoot();
  let runner: Promise<Runner> | undefined;
  const ready = (): Promise<Runner> => (runner ??= lazy.root().then(build));
  const backend: Backend = {
    problems: async () => fileBackend(await lazy.root()).problems(''),
    held: async () => {
      const files = fileBackend(await lazy.root());
      return (await files.held?.('')) ?? false;
    },
    sweep: async () => fileBackend(await lazy.root()).sweep('', []),
  };
  return {
    runner: async (name, section) => (await ready())(name, section),
    backend,
    limit: 1,
    dispose: async () => {
      const root = lazy.peek();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    },
  };
}

const arkiFile = (): Impl =>
  fileImpl(root => {
    const locks = createLocks({ store: fileStore(root), namespace: 'bench' });
    return (name, section) => locks.mutex(name).run(section, { wait: WAIT });
  });

const properLockfile = (): Impl =>
  fileImpl(root => async (name, section) => {
    // The target does not exist; proper-lockfile only makes `<target>.lock`. Same 10 ms retry gap.
    const release = await lockfile.lock(path.join(root, name), {
      realpath: false,
      stale: 10_000,
      retries: { retries: 3000, factor: 1, minTimeout: RETRY_MS, maxTimeout: RETRY_MS },
    });
    try {
      await section();
    } finally {
      await release();
    }
  });

const isExists = (error: unknown): boolean => isRecord(error) && error['code'] === 'EEXIST';

const rawMkdir = (): Impl =>
  fileImpl(root => async (name, section) => {
    const lockPath = path.join(root, `${name}.lock`);
    await spin(async () => {
      try {
        await mkdir(lockPath);
        return true;
      } catch (error) {
        if (isExists(error)) return false;
        throw error;
      }
    }, RETRY_MS);
    try {
      await section();
    } finally {
      await rmdir(lockPath);
    }
  });

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type CaseState = { readonly base: ImplState; readonly callers: number };

type CaseDefinition = {
  readonly label: string;
  readonly package?: string;
  readonly make: () => Impl;
  readonly variant?: boolean;
  /** Record entry order and require FIFO. */
  readonly fifo?: boolean;
};

function concurrentCase(definition: CaseDefinition): CaseSpec<number, CaseState, Promise<Outcome>> {
  const fifo = definition.fifo === true;
  return {
    label: definition.label,
    ...(definition.package === undefined ? {} : { package: definition.package }),
    ...(definition.variant === true ? { variant: true } : {}),
    setup: callers => ({ base: newState(definition.make()), callers }),
    run: state => runConcurrent(state.base, state.callers, { trace: fifo }),
    normalize: outcome => judge(outcome, { fifo }),
    teardown: state => finish(state.base),
  };
}

/** Sequential single callers on 10 000 random names, cycling: nothing to cache. */
type SequentialState = {
  readonly base: ImplState;
  readonly names: readonly string[];
  readonly cursor: { next: number };
};

function sequentialCase(definition: CaseDefinition): CaseSpec<number, SequentialState, Promise<Outcome>> {
  return {
    label: definition.label,
    ...(definition.package === undefined ? {} : { package: definition.package }),
    setup: () => {
      const base = newState(definition.make());
      return {
        base,
        names: Array.from({ length: 10_000 }, () => `${base.prefix}:${randomUUID()}`),
        cursor: { next: 0 },
      };
    },
    run: state => runSequential(state.base, state.names, state.cursor),
    normalize: outcome => judge(outcome),
    teardown: state => finish(state.base),
  };
}

type Definitions = Readonly<Record<string, CaseDefinition>>;

const concurrentGroup = (spec: {
  id: string;
  title: string;
  contract: string;
  inputs: readonly number[];
  baseline: string;
  note?: string;
  cases: Definitions;
}) =>
  compare<number>({
    id: spec.id,
    title: spec.title,
    contract: { id: `lock-${spec.id}/v1`, description: spec.contract },
    inputs: spec.inputs,
    expected: expectedFor,
    mode: 'async',
    baseline: spec.baseline,
    ...(spec.note === undefined ? {} : { note: spec.note }),
    cases: c =>
      Object.fromEntries(Object.entries(spec.cases).map(([key, definition]) => [key, c(concurrentCase(definition))])),
  });

const sequentialGroup = (spec: {
  id: string;
  title: string;
  contract: string;
  baseline: string;
  note?: string;
  cases: Definitions;
}) =>
  compare<number>({
    id: spec.id,
    title: spec.title,
    contract: { id: `lock-${spec.id}/v1`, description: spec.contract },
    inputs: [1],
    expected: expectedFor,
    mode: 'async',
    baseline: spec.baseline,
    ...(spec.note === undefined ? {} : { note: spec.note }),
    cases: c =>
      Object.fromEntries(Object.entries(spec.cases).map(([key, definition]) => [key, c(sequentialCase(definition))])),
  });

const MUTEX_CONTRACT =
  'every caller runs; never more than one caller is inside the section at once (counted inside it); an exclusion probe (12 callers, 3 ms section) sees one at a time; the backend itself (not the library) shows the lock held inside the section, and nothing is left held afterwards';
const SEMAPHORE_CONTRACT =
  'every task runs; never more than `limit` tasks are inside at once, and the probe reaches `limit` (counted inside the section); the backend itself shows the lock held inside the section, and nothing is left held afterwards';
const LEASE_CONTRACT = `${MUTEX_CONTRACT}; the backend shows a time-to-live above 0 while held`;

// Hand-off: release of one caller to acquire of the next, sampled per request inside the case.
// `@arki/bench` reports p99 over block estimates, so the per-request p50 and p99 are metric groups.
function handoffMetric(spec: {
  id: string;
  title: string;
  callers: number;
  quantile: number;
  baseline: string;
  cases: Definitions;
}): MetricSpec {
  return metric({
    id: spec.id,
    title: spec.title,
    unit: 'ms',
    deterministic: false,
    baseline: spec.baseline,
    note: `${spec.callers} callers on one key. Every repeat builds a fresh store and first does one untimed warm-up run on it (so connecting, SUBSCRIBE and LISTEN are not in the samples), then one measured run. The value is the percentile of the per-request release-to-next-acquire gaps pooled from every repeat so far (${spec.callers - 1} per repeat). The contract is checked on every run and a broken one throws.`,
    cases: Object.fromEntries(
      Object.entries(spec.cases).map(([key, definition]) => {
        const pooled: number[] = [];
        return [
          key,
          {
            label: definition.label,
            ...(definition.package === undefined ? {} : { package: definition.package }),
            collect: async () => {
              const state = newState(definition.make());
              try {
                for (const timed of [false, true]) {
                  const outcome = await runConcurrent(state, spec.callers, { trace: true });
                  const verdict = await judge(outcome);
                  if (verdict !== expectedFor(spec.callers)) throw new Error(`${definition.label}: ${verdict}`);
                  if (timed) pooled.push(...handoffGaps(outcome.meter));
                }
                return percentile(pooled, spec.quantile);
              } finally {
                await finish(state);
              }
            },
          },
        ];
      }),
    ),
  });
}

const redisHandoffCases: Definitions = {
  arki: { label: '@arki/lock redisStore (pub/sub wake)', package: '@arki/lock', make: () => arkiRedis(1) },
  arkiPoll: {
    label: '@arki/lock redisStore (wake: poll, backoff up to 1 s)',
    package: '@arki/lock',
    variant: true,
    make: () => arkiRedis(1, 'poll'),
  },
  redisSemaphore: {
    label: 'redis-semaphore Mutex (10 ms retry)',
    package: 'redis-semaphore',
    make: () => redisSemaphoreMutexImpl(),
  },
  redlockUniversal: {
    label: 'redlock-universal (10 ms retry)',
    package: 'redlock-universal',
    make: redlockUniversalImpl,
  },
  raw: { label: 'raw ioredis SET NX PX + Lua (10 ms spin)', package: 'ioredis', make: rawRedisImpl },
};

const pgHandoffCases: Definitions = {
  arkiAdvisory: { label: '@arki/lock pgSession (waits in Postgres)', package: '@arki/lock', make: arkiAdvisory },
  arkiLeasePoll: {
    label: '@arki/lock pgLease (poll, backoff up to 1 s)',
    package: '@arki/lock',
    variant: true,
    make: () => arkiLease(false),
  },
  arkiLeaseListen: {
    label: '@arki/lock pgLease (LISTEN)',
    package: '@arki/lock',
    variant: true,
    make: () => arkiLease(true),
  },
  pgAdvisoryLock: {
    label: 'pg-advisory-lock withLock',
    package: 'pg-advisory-lock',
    make: () => pgAdvisoryLockPackage('wait'),
  },
  raw: { label: 'raw pg_advisory_lock in a transaction', package: 'postgres', make: rawAdvisoryWait },
};

// Lease renewal: hold N leases for a window and count the commands Redis processes.
const RENEWAL_LEASES = 200;
const RENEWAL_WINDOW_MS = 60_000;
// Shorter than the window, so every library renews at least once inside it.
const RENEWAL_TTL_MS = 9000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Counts the commands clients send from now until `stop()`. `watcher` must be a connection used for nothing else. */
async function counting(watcher: Redis): Promise<{ stop(): number }> {
  const feed = await watcher.monitor();
  let count = 0;
  const onCommand = (_time: string, _args: readonly string[], source: string): void => {
    if (source !== 'lua') count += 1;
  };
  feed.on('monitor', onCommand);
  return {
    stop: () => {
      feed.off('monitor', onCommand);
      return count;
    },
  };
}

/** Commands per second Redis processes while `RENEWAL_LEASES` leases are held for the window. */
async function renewalCommandsPerSecond(make: () => Impl): Promise<number> {
  const state = newState(make());
  const watcher = new Redis(redisUrl);
  let release: () => void = nothing;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let acquired = 0;
  let reachedAll: () => void = nothing;
  const all = new Promise<void>(resolve => {
    reachedAll = resolve;
  });
  const holders = Array.from({ length: RENEWAL_LEASES }, () =>
    state.impl.runner(`${state.prefix}:${randomUUID()}`, async () => {
      acquired += 1;
      if (acquired === RENEWAL_LEASES) reachedAll();
      await gate;
    }),
  );
  try {
    await all;
    // MONITOR lists a command sent by a client as it arrives, and every step a Lua script runs as `lua`.
    // Counting the first kind charges a library for the commands it sends, not for how it writes its script.
    const sent = await counting(watcher);
    const start = performance.now();
    await sleep(RENEWAL_WINDOW_MS);
    const commands = sent.stop();
    const seconds = (performance.now() - start) / 1000;
    const keys = await redis.keys(`*${state.prefix}*`);
    const held = keys.filter(key => !isFenceCounter(key)).length;
    if (held !== RENEWAL_LEASES)
      throw new Error(`${held} of ${RENEWAL_LEASES} leases were still held after the window`);
    return commands / seconds;
  } finally {
    release();
    await Promise.all(holders);
    watcher.disconnect();
    await finish(state);
  }
}

const renewalLeaseMs = RENEWAL_TTL_MS;

function renewalImpl(kind: 'arki' | 'semaphore' | 'semaphoreThird' | 'redlock'): Impl {
  if (kind === 'arki') {
    const store = redisStore(redis, { ttl: renewalLeaseMs });
    const locks = createLocks({ store, namespace: 'bench' });
    return redisImpl(
      1,
      (name, section) => locks.mutex(name).run(section, { wait: WAIT }),
      async () => store.dispose?.(),
    );
  }
  if (kind === 'redlock') {
    const adapter = new IoredisAdapter(redis);
    return redisImpl(1, async (name, section) => {
      await createLock({ adapter, key: name, ttl: renewalLeaseMs }).using(section);
    });
  }
  return redisImpl(1, async (name, section) => {
    const mutex = new RedisMutex(redis, name, {
      lockTimeout: renewalLeaseMs,
      acquireTimeout: LEASE_MS,
      ...(kind === 'semaphoreThird' ? { refreshInterval: renewalLeaseMs / 3 } : {}),
    });
    await mutex.acquire();
    try {
      await section();
    } finally {
      await mutex.release();
    }
  });
}

const tryRunCases: Definitions = {
  raw: {
    label: 'raw SQL, 4 statements: BEGIN, pg_try_advisory_lock, unlock, COMMIT',
    package: 'postgres',
    make: rawAdvisoryTry,
  },
  rawReserved: {
    label: 'raw SQL, 2 statements on a reserved connection: pg_try_advisory_lock, unlock',
    package: 'postgres',
    variant: true,
    make: rawAdvisoryTryReserved,
  },
  arki: { label: '@arki/lock pgSession tryRun', package: '@arki/lock', make: arkiAdvisoryTry },
  pgAdvisoryLock: {
    label: 'pg-advisory-lock tryWithLock',
    package: 'pg-advisory-lock',
    make: () => pgAdvisoryLockPackage('try'),
  },
};

export default defineSuite({
  id: '@arki/lock',
  intro:
    '`@arki/lock` against async-mutex, p-limit, redis-semaphore, redlock-universal, pg-advisory-lock, proper-lockfile and hand-written baselines, on in-memory maps, Redis 7, Postgres 17 and the file system.',
  notes: [
    'Redis and Postgres run in local Docker containers on this machine (loopback), so numbers show library overhead and round trips, not a network.',
    'Every library gets the same keys, one shared ioredis client or one shared postgres.js pool, a 30 s lease, a 10 ms retry gap for the competitors and raw baselines that have to poll (our poll modes, `wake: poll` and pgLease without LISTEN, have no interval option: they back off with jitter up to 1 s), the same critical section and the same release. Every group checks, before timing and for every library, that at most one caller (at most `limit` for a semaphore) is inside the section, with an exclusion probe whose section lasts 3 ms, and that the backend holds nothing afterwards.',
    'Our Redis fence counter and our lease-table rows are kept on purpose (a fence must never go back). The clean check looks for held locks, not for those. Fresh random keys make our Redis and lease-table runs insert a new fence every time; the raw baselines delete their key or row instead.',
    'node-redlock (a beta) and the Sesame fork (UNLICENSED) are not compared. Renewal latency per request cannot be read without wrapping the client of each library, so only the commands Redis receives are counted.',
  ],
  groups: [
    sequentialGroup({
      id: 'mem/uncontended',
      title: 'Take and give back a free lock (memory, 10 000 keys)',
      contract: MUTEX_CONTRACT,
      baseline: 'chain',
      cases: {
        chain: { label: 'hand-written promise chain per key', make: chainImpl },
        arki: { label: '@arki/lock memoryStore mutex', package: '@arki/lock', make: () => arkiMemory(1) },
        asyncMutex: {
          label: 'async-mutex Mutex.runExclusive (one per key)',
          package: 'async-mutex',
          make: asyncMutexImpl,
        },
        pLimit: { label: 'p-limit 3.1.0 (1) (one per key)', package: 'p-limit', make: () => pLimitImpl(1) },
      },
    }),
    concurrentGroup({
      id: 'mem/contended',
      title: 'Many callers on one lock (memory, FIFO)',
      contract: `${MUTEX_CONTRACT}; callers enter in the order they asked (FIFO)`,
      inputs: [250, 1000],
      baseline: 'chain',
      cases: {
        chain: { label: 'hand-written promise chain', make: chainImpl, fifo: true },
        arki: { label: '@arki/lock memoryStore mutex', package: '@arki/lock', make: () => arkiMemory(1), fifo: true },
        asyncMutex: {
          label: 'async-mutex Mutex.runExclusive',
          package: 'async-mutex',
          make: asyncMutexImpl,
          fifo: true,
        },
        pLimit: { label: 'p-limit 3.1.0 (1)', package: 'p-limit', make: () => pLimitImpl(1), fifo: true },
      },
    }),
    concurrentGroup({
      id: 'mem/semaphore',
      title: 'Many tasks, 10 at a time (memory)',
      contract: SEMAPHORE_CONTRACT,
      inputs: [200, 1000],
      baseline: 'pLimit',
      note: 'No hand-written baseline: p-limit is the reference. p-limit is 3.1.0, the version the root catalog pins (7.x is current on npm).',
      cases: {
        pLimit: { label: 'p-limit 3.1.0 (10)', package: 'p-limit', make: () => pLimitImpl(10) },
        arki: { label: '@arki/lock memoryStore semaphore', package: '@arki/lock', make: () => arkiMemory(10) },
        asyncSemaphore: {
          label: 'async-mutex Semaphore(10)',
          package: 'async-mutex',
          make: () => asyncSemaphoreImpl(10),
        },
      },
    }),
    concurrentGroup({
      id: 'redis/uncontended',
      title: 'Take and give back a free lock (Redis, fresh key each time)',
      contract: LEASE_CONTRACT,
      inputs: [1],
      baseline: 'raw',
      cases: {
        raw: { label: 'raw ioredis SET NX PX + Lua compare-and-delete', package: 'ioredis', make: rawRedisImpl },
        arki: { label: '@arki/lock redisStore mutex', package: '@arki/lock', make: () => arkiRedis(1) },
        redisSemaphore: {
          label: 'redis-semaphore Mutex',
          package: 'redis-semaphore',
          make: () => redisSemaphoreMutexImpl(),
        },
        redlockUniversal: {
          label: 'redlock-universal createLock().using',
          package: 'redlock-universal',
          make: redlockUniversalImpl,
        },
      },
    }),
    concurrentGroup({
      id: 'redis/handoff',
      title: 'Hand a Redis lock from caller to caller, one process (time for all callers)',
      contract: LEASE_CONTRACT,
      inputs: [10, 50],
      baseline: 'arki',
      note: 'No raw baseline: a raw lock has no wake-up, so it spins. Per-request hand-off latency is in the two metric groups below.',
      cases: redisHandoffCases,
    }),
    concurrentGroup({
      id: 'redis/semaphore',
      title: 'Many tasks, 5 at a time (Redis)',
      contract: `${SEMAPHORE_CONTRACT}; the backend shows a time-to-live above 0 while held`,
      inputs: [50, 200],
      baseline: 'raw',
      cases: {
        raw: { label: 'raw ioredis ZSET + Lua (10 ms spin)', package: 'ioredis', make: () => rawRedisSemaphoreImpl(5) },
        arki: { label: '@arki/lock redisStore semaphore', package: '@arki/lock', make: () => arkiRedis(5) },
        redisSemaphore: {
          label: 'redis-semaphore Semaphore',
          package: 'redis-semaphore',
          make: () => redisSemaphoreImpl(5),
        },
      },
    }),
    handoffMetric({
      id: 'redis/handoff-p50',
      title: 'Redis hand-off latency, median per request (pooled over repeats)',
      callers: 50,
      quantile: 0.5,
      baseline: 'arki',
      cases: redisHandoffCases,
    }),
    handoffMetric({
      id: 'redis/handoff-p99',
      title: 'Redis hand-off latency, 99th percentile per request (pooled over repeats)',
      callers: 50,
      quantile: 0.99,
      baseline: 'arki',
      cases: redisHandoffCases,
    }),
    metric({
      id: 'redis/lease-renewal',
      title: `Commands clients send to Redis per second while ${RENEWAL_LEASES} leases are held for ${RENEWAL_WINDOW_MS / 1000} s`,
      unit: 'commands/s',
      // Measured once, because each measurement holds the leases for a whole minute. Not exactly deterministic: it is a rate over a fixed window.
      deterministic: true,
      baseline: 'arki',
      note: `Lease length ${RENEWAL_TTL_MS / 1000} s for every library. Each library renews at its own default (ours at a third of the lease, redis-semaphore and redlock-universal at 80%), so those rows differ by renewal cadence; the redis-semaphore row marked refreshInterval = ttl/3 renews as often as ours. Commands are counted as clients send them (MONITOR): a Lua script is one command however many steps it runs inside Redis. The window is 60 s so every cadence renews several times (ours about 20, redis-semaphore at 80% about 8). Every lease must still be held after the window or the run throws.`,
      cases: {
        arki: {
          label: '@arki/lock redisStore (renews at ttl/3)',
          package: '@arki/lock',
          collect: () => renewalCommandsPerSecond(() => renewalImpl('arki')),
        },
        redisSemaphore: {
          label: 'redis-semaphore (default refresh, 80%)',
          package: 'redis-semaphore',
          collect: () => renewalCommandsPerSecond(() => renewalImpl('semaphore')),
        },
        redisSemaphoreThird: {
          label: 'redis-semaphore (refreshInterval = ttl/3)',
          package: 'redis-semaphore',
          collect: () => renewalCommandsPerSecond(() => renewalImpl('semaphoreThird')),
        },
        redlockUniversal: {
          label: 'redlock-universal using() (auto-extend)',
          package: 'redlock-universal',
          collect: () => renewalCommandsPerSecond(() => renewalImpl('redlock')),
        },
      },
    }),
    concurrentGroup({
      id: 'pg/advisory-tryrun',
      title: 'Try to run under a Postgres advisory lock (1 caller on a free key, or 4 at once where 3 find it held)',
      contract: `${MUTEX_CONTRACT}; with several callers at least one runs and the others skip`,
      inputs: [1, 4],
      baseline: 'raw',
      cases: tryRunCases,
    }),
    metric({
      id: 'pg/advisory-tryrun-ran',
      title: 'Callers that ran, of 4 started at once on a free key (Postgres advisory tryRun)',
      unit: 'callers',
      deterministic: false,
      baseline: 'raw',
      note: 'The rest found the lock held and skipped. How many run depends on how fast a library releases, so this is reported, not ranked.',
      cases: Object.fromEntries(
        Object.entries(tryRunCases).map(([key, definition]) => [
          key,
          {
            label: definition.label,
            ...(definition.package === undefined ? {} : { package: definition.package }),
            collect: async () => {
              const state = newState(definition.make());
              try {
                const outcome = await runConcurrent(state, 4);
                return outcome.done;
              } finally {
                await finish(state);
              }
            },
          },
        ]),
      ),
    }),
    sequentialGroup({
      id: 'pg/xact',
      title: 'Lock inside a transaction you already open (Postgres)',
      contract: MUTEX_CONTRACT,
      baseline: 'raw',
      note: 'Each run opens its own transaction; the lock is taken in it and ends with it. Ours builds `createLocks` on that transaction handle, as the API requires.',
      cases: {
        raw: { label: 'raw pg_advisory_xact_lock', package: 'postgres', make: rawXact },
        arki: { label: '@arki/lock pgTransaction', package: '@arki/lock', make: arkiXact },
      },
    }),
    concurrentGroup({
      id: 'pg/lease',
      title: 'Take and give back a Postgres lease (fresh key each time)',
      contract: LEASE_CONTRACT,
      inputs: [1],
      baseline: 'raw',
      note: 'Every run uses a new key, so both sides INSERT. The raw baseline has no fence and deletes its row on release; ours keeps the row (marked free) so the fence never repeats.',
      cases: {
        raw: { label: 'raw INSERT .. ON CONFLICT upsert + DELETE', package: 'postgres', make: rawLease },
        arki: {
          label: '@arki/lock pgLease (poll, backoff up to 1 s)',
          package: '@arki/lock',
          make: () => arkiLease(false),
        },
      },
    }),
    concurrentGroup({
      id: 'pg/handoff',
      title: 'Hand a Postgres lock from caller to caller (time for all callers)',
      contract: MUTEX_CONTRACT,
      inputs: [5, 20],
      baseline: 'arkiAdvisory',
      note: 'The two lease rows must also show a time-to-live above 0 while held; an advisory lock has none.',
      cases: pgHandoffCases,
    }),
    handoffMetric({
      id: 'pg/handoff-p50',
      title: 'Postgres hand-off latency, median per request (pooled over repeats)',
      callers: 20,
      quantile: 0.5,
      baseline: 'arkiAdvisory',
      cases: pgHandoffCases,
    }),
    handoffMetric({
      id: 'pg/handoff-p99',
      title: 'Postgres hand-off latency, 99th percentile per request (pooled over repeats)',
      callers: 20,
      quantile: 0.99,
      baseline: 'arkiAdvisory',
      cases: pgHandoffCases,
    }),
    sequentialGroup({
      id: 'file/uncontended',
      title: 'Take and give back a free lock file (file system)',
      contract: `${MUTEX_CONTRACT}; the lock directory is empty afterwards`,
      baseline: 'raw',
      cases: {
        raw: { label: 'raw mkdir / rmdir', make: rawMkdir },
        arki: { label: '@arki/lock fileStore', package: '@arki/lock', make: arkiFile },
        properLockfile: { label: 'proper-lockfile', package: 'proper-lockfile', make: properLockfile },
      },
    }),
  ],
});
