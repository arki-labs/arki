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

import type { AcquireRequest, Duration, Grant, Guarantees, Key, ReleaseOutcome, Store } from '../types.js';
import { LockError } from '../errors.js';
import { MIN_LEASE_TTL_MS } from '../locks.js';
import { parseDuration } from '../wait.js';
import { DEFAULT_LEASE_TABLE, leaseTableSql, tableIdentifier } from './lease.sql.js';

export { DEFAULT_LEASE_TABLE, LEASE_TABLE_SQL, leaseTableSql } from './lease.sql.js';

const log = getLogger('arki:lock:pg-lease');

/** The channel release notifies on. Payload = `key.full`. */
const CHANNEL = 'arki_lock';

const baseGuarantees = {
  kind: 'lease',
  scope: 'cluster',
  shared: false,
  // Semaphore rows are Phase 2: the table has `permits_limit`, the store has no permit ops yet.
  permits: false,
  fence: 'durable',
  releasedOnCrash: 'after-ttl',
  clock: 'store',
  poolerSafe: true,
  runtimes: ['node', 'bun', 'deno'],
} as const;

const pollGuarantees = { ...baseGuarantees, wait: 'poll' } as const satisfies Guarantees;
const wakeGuarantees = { ...baseGuarantees, wait: 'wake' } as const satisfies Guarantees;

export type PgLeasePollGuarantees = typeof pollGuarantees;
export type PgLeaseWakeGuarantees = typeof wakeGuarantees;

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

export type PgLeaseStore<G extends PgLeasePollGuarantees | PgLeaseWakeGuarantees> = Store<G>;

const acquireRowSchema = z.object({ generation: z.string(), expires_ms: z.string() });
const freeRowSchema = z.object({ free: z.boolean() });
const timestampRowSchema = z.object({ ts: z.string() });
const notificationSchema = z.object({ channel: z.string(), payload: z.string().optional() });

function rowsOf(result: unknown): readonly unknown[] {
  if (Array.isArray(result)) return result;
  if (typeof result === 'object' && result !== null && 'rows' in result && Array.isArray(result.rows))
    return result.rows;
  return [];
}

const intervalMs = (ms: number): SQL => sql`(${ms}::double precision) * interval '1 millisecond'`;

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
export async function ensureLockTable(db: LeaseDb, table: string = DEFAULT_LEASE_TABLE): Promise<void> {
  const ddl = leaseTableSql(table);
  // Two sessions running CREATE TABLE IF NOT EXISTS at once can both miss the
  // table, and one then fails on pg_type. The lock makes the second one wait.
  await db.execute(
    sql.raw(`DO $arki$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('@arki/lock'), hashtext('${table}'));
  ${ddl}
END $arki$`),
  );
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

  const shared = {
    name: 'pg-lease',
    ttlMs,
    async acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
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
      if (row === undefined) return undefined;
      const parsed = acquireRowSchema.parse(row);
      return { key, token: req.token, fence: BigInt(parsed.generation), expiresAt: Number(parsed.expires_ms) };
    },
    async release(grant: Grant): Promise<ReleaseOutcome> {
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
    },
    async extend(grant: Grant, extendMs: number): Promise<boolean> {
      const result = await db.execute(sql`
        UPDATE ${table}
          SET expires_at = clock_timestamp() + ${intervalMs(extendMs)}
          WHERE key = ${grant.key.full} AND token = ${grant.token} AND expires_at > clock_timestamp()
          RETURNING 1 AS ok
      `);
      return rowsOf(result).length > 0;
    },
  };

  if (!('listen' in options)) return { ...shared, guarantees: pollGuarantees };
  const isFree = async (key: Key): Promise<boolean> => {
    const result = await db.execute(sql`
      SELECT NOT EXISTS (
        SELECT 1 FROM ${table} WHERE key = ${key.full} AND token IS NOT NULL AND expires_at > clock_timestamp()
      ) AS free
    `);
    return freeRowSchema.parse(rowsOf(result)[0]).free;
  };
  return { ...shared, guarantees: wakeGuarantees, ...listener(options.listen, isFree) };
}

/** `waitFor` and `dispose` over one lazily opened LISTEN connection, shared by every waiter. */
function listener(
  connect: () => Promise<ListenClient>,
  isFree: (key: Key) => Promise<boolean>,
): Pick<Store, 'waitFor' | 'dispose'> {
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
    async waitFor(key: Key, signal: AbortSignal): Promise<void> {
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
        if (listening && (await isFree(key))) done();
      } catch (error) {
        done();
        throw error;
      }
      await promise;
    },
    async dispose(): Promise<void> {
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
    },
  };
}
