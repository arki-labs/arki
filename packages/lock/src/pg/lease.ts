import { observeLock } from '../telemetry.js';
/**
 * `pgLease`: a lease in a Postgres table, with a durable fence.
 *
 * Every time comes from the database clock, and always `clock_timestamp()`:
 * `now()` is the start of the caller's transaction, so inside a long
 * transaction a lease would never look expired. Release keeps the row
 * (`token = NULL`) so `generation` never restarts. A crashed holder frees the
 * key `ttl` after its last renewal.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getLogger } from '@arki/log';

import type {
  AcquireRequest,
  Duration,
  Grant,
  Guarantees,
  Key,
  PermitOps,
  PermitRequest,
  Store,
  Waiter,
} from '../types.js';
import { lockFenceSchema } from '../identity-schemas.js';
import { LockError, storeFailure } from '../errors.js';
import { MIN_LEASE_TTL_MS } from '../locks.js';
import { limitSchema, weightSchema } from '../schemas.js';
import { parseDuration } from '../wait.js';
import { DEFAULT_LEASE_TABLE, leaseTableSql, leaseUpgradeSql, tableIdentifier } from './lease.sql.js';

export { DEFAULT_LEASE_TABLE, LEASE_TABLE_SQL, leaseTableSql, leaseUpgradeSql } from './lease.sql.js';

const log = getLogger('arki:lock:pg-lease');

/** The channel release notifies on. Payload = `key.full`. */
const CHANNEL = 'arki_lock';

const baseGuarantees = {
  kind: 'lease',
  scope: 'cluster',
  shared: false,
  permits: true,
  fence: 'durable',
  releasedOnCrash: 'after-ttl',
  clock: 'store',
  poolerSafe: true,
  runtimes: ['node', 'bun', 'deno'],
} as const;

/** What `pgLease(db, { ttl })` promises: waiters poll. */
export const pgLeasePollGuarantees = { ...baseGuarantees, wait: 'poll' } as const satisfies Guarantees;
/** What `pgLease(db, { ttl, listen })` promises: waiters wake on release. */
export const pgLeaseWakeGuarantees = { ...baseGuarantees, wait: 'wake' } as const satisfies Guarantees;

export type PgLeasePollGuarantees = typeof pgLeasePollGuarantees;
export type PgLeaseWakeGuarantees = typeof pgLeaseWakeGuarantees;

/**
 * The least a database must offer: raw SQL (drizzle on node-postgres, postgres.js or PGlite).
 * Autocommit only, never a transaction handle: a rollback would undo an acquire
 * (and hand the same fence out again) or undo a release (and keep the key held to ttl).
 * The first acquire checks this and refuses a transaction with `LockError{code:'config'}`.
 */
export type LeaseDb = {
  execute(query: SQL): PromiseLike<unknown>;
};

/**
 * A dedicated connection for LISTEN, such as `pool.connect()` on node-postgres.
 * Never a pooled-per-statement connection: LISTEN lives on one session.
 */
export type ListenClient = {
  query(text: string): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  /** `true` destroys the connection. */
  release(error?: Error | boolean): void;
};

export type PgLeaseOptions = {
  /** How long the lease lasts without renewal. At least 1 s. */
  readonly ttl: Duration;
  /** Default `arki_lock`. `name` or `schema.name`. */
  readonly table?: string;
};

export type PgLeaseListenOptions = PgLeaseOptions & {
  /**
   * Gives a dedicated connection. With it, waiters wake on release instead of polling.
   * A direct connection: through PgBouncer in transaction mode LISTEN hears nothing.
   */
  readonly listen: () => Promise<ListenClient>;
};

export type PgLeaseStore<G extends PgLeasePollGuarantees | PgLeaseWakeGuarantees> = Store<G> & {
  readonly permits: PermitOps;
};

const acquireRowSchema = z.object({ generation: z.string(), expires_ms: z.string() });
const freeRowSchema = z.object({ free: z.boolean() });
const timestampRowSchema = z.object({ ts: z.string() });
const notificationSchema = z.object({ channel: z.string(), payload: z.string().optional() });

const resultRowsSchema = z.union([z.array(z.unknown()), z.object({ rows: z.array(z.unknown()) })]);
function rowsOf(result: unknown): readonly unknown[] {
  const parsed = resultRowsSchema.parse(result);
  return Array.isArray(parsed) ? parsed : parsed.rows;
}

const limitRowSchema = z.object({ conflict: z.boolean() });

const intervalMs = (ms: number): SQL => sql`(${ms}::double precision) * interval '1 millisecond'`;

/** Now, in ms since the epoch, from the database clock (never `now()`, which is the start of a transaction). */
const NOW_MS = sql`(extract(epoch FROM clock_timestamp()) * 1000)`;

/** The holders in `l.holders` whose lease has not run out. */
const LIVE_HOLDERS = sql`(SELECT coalesce(jsonb_agg(h), '[]'::jsonb) FROM jsonb_array_elements(l.holders) AS h WHERE (h->>'e')::double precision > ${NOW_MS})`;
const LIVE_WEIGHT = sql`(SELECT coalesce(sum((h->>'w')::integer), 0) FROM jsonb_array_elements(l.holders) AS h WHERE (h->>'e')::double precision > ${NOW_MS})`;

/**
 * Refuse a handle that runs inside one transaction. Two separate statements:
 * in autocommit each is its own transaction, so `transaction_timestamp()`
 * differs; inside a transaction block both return its start. The first sleeps
 * 2 ms so a coarse database clock still moves between two autocommit statements.
 */
async function assertAutocommit(db: LeaseDb): Promise<void> {
  const first = await db.execute(sql`SELECT transaction_timestamp()::text AS ts FROM pg_sleep(0.002)`);
  const second = await db.execute(sql`SELECT transaction_timestamp()::text AS ts`);
  if (timestampRowSchema.parse(rowsOf(first)[0]).ts === timestampRowSchema.parse(rowsOf(second)[0]).ts) {
    throw new LockError({
      code: 'config',
      message:
        'pgLease needs an autocommit handle (a pool/db), not a transaction: a rollback would undo the acquire and repeat the fence',
      remediation: 'Pass the pool or db, not the handle from db.transaction().',
    });
  }
}

/** Create the lease table if it is not there. Safe to call at every boot, from every replica at once. */
export async function ensureLockTable(db: LeaseDb, table: string = DEFAULT_LEASE_TABLE) {
 return observeLock('store.ddl', async () => {
      try {
  const ddl = leaseTableSql(table);
  // Two sessions running CREATE TABLE IF NOT EXISTS at once can both miss the
  // table, and one then fails on pg_type. The lock makes the second one wait.
  await db.execute(
    sql.raw(`DO $arki$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('@arki/lock'), hashtext('${table}'));
  ${ddl}
  ${leaseUpgradeSql(table)}
END $arki$`),
  );

        return;
      } catch (error) { return storeFailure(error, 'ddl'); }

 });
}

export function pgLease(db: LeaseDb, options: PgLeaseOptions): PgLeaseStore<PgLeasePollGuarantees>;
export function pgLease(db: LeaseDb, options: PgLeaseListenOptions): PgLeaseStore<PgLeaseWakeGuarantees>;
export function pgLease(
  db: LeaseDb,
  options: PgLeaseOptions | PgLeaseListenOptions,
): PgLeaseStore<PgLeasePollGuarantees> | PgLeaseStore<PgLeaseWakeGuarantees> {
  const ttlMs = parseDuration(options.ttl);
  if (!(ttlMs >= MIN_LEASE_TTL_MS)) {
    throw new LockError({
      code: 'config',
      message: `lease ttl ${ttlMs} ms is below the renewal floor of ${MIN_LEASE_TTL_MS} ms`,
      remediation: `Use a ttl of at least ${MIN_LEASE_TTL_MS} ms.`,
    });
  }
  const table = tableIdentifier(options.table ?? DEFAULT_LEASE_TABLE);

  // One probe per store, shared by concurrent first acquires. A refusal is
  // kept (the handle will not change); a network failure is not, so it retries.
  let autocommit: Promise<void> | undefined;
  const ensureAutocommit = (): Promise<void> => {
    autocommit ??= assertAutocommit(db).catch((error: unknown) => {
      if (!(error instanceof LockError)) autocommit = undefined;
      throw error;
    });
    return autocommit;
  };

  /**
   * Semaphore protocol. One row per key; its live holders are inside the row (see `lease.sql.ts`).
   * Every statement below changes that row, so Postgres locks it first and re-reads it before
   * it checks the WHERE: the capacity test sees every grant already committed.
   */
  const permits: PermitOps = {
    async acquire(key: Key, req: PermitRequest) {
 return observeLock('store.acquire', async () => {
      try {
      const { limit, weight, token } = req;
      if (!limitSchema.safeParse(limit).success || !weightSchema.safeParse(weight).success || weight > limit) {
        throw new LockError({
          code: 'config',
          message: `weight ${weight} and limit ${limit} must be positive integers with weight at most the limit`,
          remediation: 'Pass a positive integer weight of at most the limit.',
        });
      }
      await ensureAutocommit();
      const leaseMs = req.ttlMs ?? ttlMs;
      const holder = (fence: SQL): SQL =>
        sql`jsonb_build_object('t', ${token}::text, 'w', ${weight}::integer, 'f', ${fence}, 'e', ${NOW_MS} + ${leaseMs}::double precision)`;
      const result = await db.execute(sql`
        INSERT INTO ${table} AS l (key, generation, expires_at, permits_limit, holders)
        VALUES (${key.full}, 1, clock_timestamp() + ${intervalMs(leaseMs)}, ${limit}::integer,
                jsonb_build_array(${holder(sql`1`)}))
        ON CONFLICT (key) DO UPDATE
          SET generation = l.generation + 1,
              permits_limit = ${limit}::integer,
              holders = ${LIVE_HOLDERS} || jsonb_build_array(${holder(sql`l.generation + 1`)})
          WHERE ${LIVE_WEIGHT} + ${weight}::integer <= ${limit}::integer
            AND (${LIVE_WEIGHT} = 0 OR l.permits_limit = ${limit}::integer)
        RETURNING l.generation::text AS generation,
                  floor((l.holders->-1->>'e')::double precision)::text AS expires_ms
      `);
      const [row] = rowsOf(result);
      if (row !== undefined) {
        const parsed = acquireRowSchema.parse(row);
        return { key, token, fence: lockFenceSchema.parse(BigInt(parsed.generation)), expiresAt: Number(parsed.expires_ms) };
      }
      // Refused: full, or the limit disagrees with the holders'. Only the second is an error.
      const check = await db.execute(sql`
        SELECT (${LIVE_WEIGHT} > 0 AND l.permits_limit IS DISTINCT FROM ${limit}::integer) AS conflict
          FROM ${table} AS l WHERE l.key = ${key.full}
      `);
      const [checked] = rowsOf(check);
      if (checked !== undefined && limitRowSchema.parse(checked).conflict) {
        throw new LockError({
          code: 'config',
          message: `the semaphore is held with a different limit than ${limit}`,
          remediation: 'Declare one limit per semaphore key; a new limit is accepted once no hold is left.',
        });
      }
      return;
    
      } catch (error) { return storeFailure(error, 'acquire'); }

 });
},
    async release(grant: Grant) {
 return observeLock('store.release', async () => {
      try {
      const result = await db.execute(sql`
        WITH released AS (
          UPDATE ${table} AS l
            SET holders = (SELECT coalesce(jsonb_agg(h), '[]'::jsonb) FROM jsonb_array_elements(l.holders) AS h WHERE h->>'t' <> ${grant.token}::text)
            WHERE l.key = ${grant.key.full}
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.holders) AS h WHERE h->>'t' = ${grant.token}::text)
            RETURNING l.key
        )
        SELECT pg_notify(${CHANNEL}, key) FROM released
      `);
      return rowsOf(result).length > 0 ? 'released' : 'not-owner';
    
      } catch (error) { return storeFailure(error, 'release'); }

 });
},
    async extend(grant: Grant, extendMs: number) {
 return observeLock('store.extend', async () => {
      try {
      const result = await db.execute(sql`
        UPDATE ${table} AS l
          SET holders = (
            SELECT jsonb_agg(CASE WHEN h->>'t' = ${grant.token}::text
                                  THEN jsonb_set(h, '{e}', to_jsonb(${NOW_MS} + ${extendMs}::double precision))
                                  ELSE h END)
              FROM jsonb_array_elements(l.holders) AS h)
          WHERE l.key = ${grant.key.full}
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.holders) AS h
                         WHERE h->>'t' = ${grant.token}::text AND (h->>'e')::double precision > ${NOW_MS})
          RETURNING 1 AS ok
      `);
      return rowsOf(result).length > 0;
    
      } catch (error) { return storeFailure(error, 'extend'); }

 });
},
  };

  const shared = {
    name: 'pg-lease',
    permits,
    ttlMs,
    async acquire(key: Key, req: AcquireRequest) {
 return observeLock('store.acquire', async () => {
      try {
      await ensureAutocommit();
      const leaseMs = req.ttlMs ?? ttlMs;
      const result = await db.execute(sql`
        INSERT INTO ${table} AS lease (key, token, generation, expires_at)
        VALUES (${key.full}, ${req.token}, 1, clock_timestamp() + ${intervalMs(leaseMs)})
        ON CONFLICT (key) DO UPDATE
          SET token = ${req.token},
              generation = lease.generation + 1,
              expires_at = clock_timestamp() + ${intervalMs(leaseMs)}
          WHERE lease.token IS NULL OR lease.expires_at <= clock_timestamp()
        RETURNING lease.generation::text AS generation,
                  floor(extract(epoch FROM lease.expires_at) * 1000)::text AS expires_ms
      `);
      const [row] = rowsOf(result);
      if (row === undefined) return;
      const parsed = acquireRowSchema.parse(row);
      return { key, token: req.token, fence: lockFenceSchema.parse(BigInt(parsed.generation)), expiresAt: Number(parsed.expires_ms) };
    
      } catch (error) { return storeFailure(error, 'acquire'); }

 });
},
    async release(grant: Grant) {
 return observeLock('store.release', async () => {
      try {
      // The row stays: `generation` must survive. Notify so waiters wake at once.
      const result = await db.execute(sql`
        WITH released AS (
          UPDATE ${table}
            SET token = NULL, expires_at = clock_timestamp()
            WHERE key = ${grant.key.full} AND token = ${grant.token}
            RETURNING key
        )
        SELECT pg_notify(${CHANNEL}, key) FROM released
      `);
      return rowsOf(result).length > 0 ? 'released' : 'not-owner';
    
      } catch (error) { return storeFailure(error, 'release'); }

 });
},
    async extend(grant: Grant, extendMs: number) {
 return observeLock('store.extend', async () => {
      try {
      const result = await db.execute(sql`
        UPDATE ${table}
          SET expires_at = clock_timestamp() + ${intervalMs(extendMs)}
          WHERE key = ${grant.key.full} AND token = ${grant.token} AND expires_at > clock_timestamp()
          RETURNING 1 AS ok
      `);
      return rowsOf(result).length > 0;
    
      } catch (error) { return storeFailure(error, 'extend'); }

 });
},
  };

  /** True when `weight` more permits fit on `key` now (no row, no live holder, or room left). */
  const fits = async (key: Key, weight: number): Promise<boolean> => {
    const result = await db.execute(sql`
      SELECT NOT EXISTS (
        SELECT 1 FROM ${table} AS l
         WHERE l.key = ${key.full} AND ${LIVE_WEIGHT} > 0 AND ${LIVE_WEIGHT} + ${weight}::integer > l.permits_limit
      ) AS free
    `);
    return freeRowSchema.parse(rowsOf(result)[0]).free;
  };
  const withWaiter = (
    wake?: (key: Key, signal: AbortSignal, ready: () => Promise<boolean>) => Promise<void>,
  ): PermitOps => ({
    ...permits,
    waiter: (key, weight) =>
      permitWaiter(() => fits(key, weight), wake && ((signal, ready) => wake(key, signal, ready))),
  });

  if (!('listen' in options)) return { ...shared, permits: withWaiter(), guarantees: pgLeasePollGuarantees };
  const isFree = async (key: Key): Promise<boolean> => {
    const result = await db.execute(sql`
      SELECT NOT EXISTS (
        SELECT 1 FROM ${table} AS l
         WHERE l.key = ${key.full}
           AND ((l.token IS NOT NULL AND l.expires_at > clock_timestamp())
                OR (l.permits_limit IS NOT NULL AND ${LIVE_WEIGHT} >= l.permits_limit))
      ) AS free
    `);
    return freeRowSchema.parse(rowsOf(result)[0]).free;
  };
  const { waitReady, ...rest } = listener(options.listen);
  return {
    ...shared,
    permits: withWaiter(waitReady),
    guarantees: pgLeaseWakeGuarantees,
    ...rest,
    waitFor: async (key: Key, signal: AbortSignal) => {
      try { await waitReady(key, signal, () => isFree(key)); return; }
      catch (error) { return storeFailure(error, 'waitFor'); }
    },
  };
}

const WAITER_FIRST_BEAT_MS = 100;
const WAITER_MAX_BEAT_MS = 1000;

/** Sleep `ms`, or until `signal` aborts or `cancel` runs. */
function napUntil(ms: number, signal: AbortSignal): { promise: Promise<void>; cancel: () => void } {
  const done = deferredVoid();
  const timer = setTimeout(() => {
    cancel();
  }, ms);
  function cancel(): void {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    done.resolve();
  }
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  return { promise: done.promise, cancel };
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  const settlers: { resolve?: () => void } = {};
  const promise = new Promise<void>(resolve => {
    settlers.resolve = resolve;
  });
  return { promise, resolve: () => settlers.resolve?.() };
}

/**
 * One caller's wait on a semaphore key. Resolves at once if the caller would fit now. Otherwise
 * it sleeps until a release wakes it (LISTEN mode) or a beat that grows from 100 ms to 1 s ends:
 * the beat also catches a holder that crashed and simply expired, which sends no NOTIFY.
 */
function permitWaiter(
  fitsNow: () => Promise<boolean>,
  wake: ((signal: AbortSignal, ready: () => Promise<boolean>) => Promise<void>) | undefined,
): Waiter {
  let beat = WAITER_FIRST_BEAT_MS;
  const closed = new AbortController();
  return {
    async waitFor(signal: AbortSignal) {
 return observeLock('store.waitFor', async () => {
      try {
      if (signal.aborted || closed.signal.aborted || (await fitsNow())) return;
      const both = new AbortController();
      const stop = (): void => both.abort();
      signal.addEventListener('abort', stop, { once: true });
      closed.signal.addEventListener('abort', stop, { once: true });
      const nap = napUntil(beat, both.signal);
      beat = Math.min(beat * 2, WAITER_MAX_BEAT_MS);
      try {
        await Promise.race([nap.promise, wake?.(both.signal, fitsNow) ?? nap.promise]);
      } finally {
        nap.cancel();
        both.abort();
        signal.removeEventListener('abort', stop);
        closed.signal.removeEventListener('abort', stop);
      }
    
        return;
      } catch (error) { return storeFailure(error, 'waitFor'); }

 });
},
    close(): void {
      closed.abort();
    },
  };
}

/** `waitReady` (wait for a release, or until `ready()` holds) and `dispose` over one lazily opened LISTEN connection, shared by every waiter. */
function listener(connect: () => Promise<ListenClient>): {
  waitReady: (key: Key, signal: AbortSignal, ready: () => Promise<boolean>) => Promise<void>;
  dispose: () => Promise<void | import('../errors.js').StoreFailure>;
} {
  const waiters = new Map<string, Set<() => void>>();
  let connection: Promise<ListenClient> | undefined;
  let disposed = false;

  const wakeAll = (): void => {
    for (const set of waiters.values()) for (const wake of set) wake();
  };

  const open = (): Promise<ListenClient> => {
    if (disposed) return Promise.reject(new Error('the lease store was disposed'));
    // One connection for every waiter: a connection per wait would drain the pool.
    if (connection !== undefined) return connection;
    const attempt: Promise<ListenClient> = (async () => {
      const client = await connect();
      let dropped = false;
      const drop = (): void => {
        if (dropped) return;
        dropped = true;
        if (connection === attempt) connection = undefined;
        try {
          client.release(true);
        } catch (error) {
          log.debug('releasing the LISTEN connection failed: {error}', { error: String(error) });
        }
        // Waiters retry at once; the next waitFor opens a fresh connection.
        wakeAll();
      };
      client.on('notification', (message: unknown) => {
        const parsed = notificationSchema.safeParse(message);
        if (!parsed.success || parsed.data.channel !== CHANNEL || parsed.data.payload === undefined) return;
        for (const wake of waiters.get(parsed.data.payload) ?? []) wake();
      });
      client.on('error', drop);
      client.on('end', drop);
      try {
        await client.query(`LISTEN ${CHANNEL}`);
      } catch (error) {
        drop();
        throw error;
      }
      log.debug('listening on {channel}', { channel: CHANNEL });
      return client;
    })();
    connection = attempt;
    // A failed connect is not kept, so the next wait tries again.
    attempt.catch(() => {
      if (connection === attempt) connection = undefined;
    });
    return attempt;
  };

  return {
    async waitReady(key: Key, signal: AbortSignal, ready: () => Promise<boolean>): Promise<void> {
      if (signal.aborted) return;
      const set = waiters.get(key.full) ?? new Set<() => void>();
      waiters.set(key.full, set);
      let settle: (() => void) | undefined;
      const promise = new Promise<void>(resolveWait => {
        settle = resolveWait;
      });
      let woken = false;
      const done = (): void => {
        if (woken) return;
        woken = true;
        signal.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0 && waiters.get(key.full) === set) waiters.delete(key.full);
        settle?.();
      };
      set.add(done);
      signal.addEventListener('abort', done, { once: true });
      try {
        // Listen first, check after: a release before LISTEN took effect is caught
        // by the check, one after it by the notification. Raced with the wake-up
        // so an abort never waits for a slow connect.
        const listening = await Promise.race([open().then(() => true), promise.then(() => false)]);
        if (listening && (await ready())) done();
      } catch (error) {
        done();
        throw error;
      }
      await promise;
    },
    async dispose() {
 return observeLock('store.dispose', async () => {
      try {
      if (disposed) return;
      disposed = true;
      const pending = connection;
      connection = undefined;
      wakeAll();
      if (pending === undefined) return;
      try {
        const client = await pending;
        client.release(true);
      } catch {
        // The connection never opened, or a connection error already released it.
      }
    
        return;
      } catch (error) { return storeFailure(error, 'dispose'); }

 });
},
  };
}
