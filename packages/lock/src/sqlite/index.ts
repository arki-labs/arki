import { observeLock } from '../telemetry.js';
/**
 * `sqliteLease`: a lease in a SQLite table, with a durable fence.
 *
 * The same lease model as `pgLease`: one row per key in `arki_lock`, never
 * deleted, so `generation` (the fence) never restarts. An acquire is one
 * INSERT .. ON CONFLICT DO UPDATE .. RETURNING. Every time comes from SQLite's
 * own clock, in milliseconds. Waiters poll: there is no wake-up path.
 *
 * SQLite has one writer per file. When another process holds the write lock, a
 * statement fails with SQLITE_BUSY and nothing ran. An acquire reads that as
 * "held right now", so the manager waits and tries again.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type {
  AcquireRequest,
  Duration,
  Grant,
  Guarantees,
  Key,
  PermitOps,
  PermitRequest,
  Store,
} from '../types.js';
import { lockFenceSchema } from '../identity-schemas.js';
import { LockError, storeFailure } from '../errors.js';
import { MIN_LEASE_TTL_MS } from '../locks.js';
import { DEFAULT_LEASE_TABLE, quotedTable, tableIdentifier } from '../pg/lease.sql.js';
import { limitSchema, weightSchema } from '../schemas.js';
import { parseDuration } from '../wait.js';

export { DEFAULT_LEASE_TABLE } from '../pg/lease.sql.js';

/** What `sqliteLease(db, { ttl })` promises. Every client of the database is kept apart; waiters poll. */
export const sqliteLeaseGuarantees = {
  kind: 'lease',
  scope: 'cluster',
  wait: 'poll',
  shared: false,
  permits: true,
  fence: 'durable',
  releasedOnCrash: 'after-ttl',
  clock: 'store',
  poolerSafe: true,
  runtimes: ['node', 'bun', 'deno'],
} as const satisfies Guarantees;

export type SqliteLeaseGuarantees = typeof sqliteLeaseGuarantees;

/**
 * The least a database must offer: Drizzle's raw-SQL calls on an async SQLite driver, such as
 * the `db` from `createLibsqlDb` (`@arki/db/libsql`). Its write queue then gives these
 * statements their turn with the app's own writes. Pass the database, never a transaction
 * handle: a rollback would undo an acquire and hand the same fence out twice.
 */
export type SqliteLeaseDb = {
  run(query: SQL): PromiseLike<unknown>;
  all(query: SQL): PromiseLike<readonly unknown[]>;
};

export type SqliteLeaseOptions = {
  /** How long the lease lasts without renewal. At least 1 s. */
  readonly ttl: Duration;
  /** Default `arki_lock`. `name` or `schema.name` (an attached database). */
  readonly table?: string;
};

export type SqliteLeaseStore = Store<SqliteLeaseGuarantees> & {
  readonly permits: PermitOps;
};

/** The DDL for `table`, as text. Idempotent. Times are ms since the epoch; `holders` is a JSON array. */
export function leaseTableSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${quotedTable(table)} (
  key           text    PRIMARY KEY NOT NULL,
  token         text,
  generation    integer NOT NULL DEFAULT 0,
  expires_at    integer NOT NULL DEFAULT 0,
  permits_limit integer,
  holders       text    NOT NULL DEFAULT '[]'
);`;
}

/** The DDL for the default table name, to copy into a migration. */
export const LEASE_TABLE_SQL = leaseTableSql(DEFAULT_LEASE_TABLE);

/** Create the lease table if it is not there. Safe to call at every boot. */
export async function ensureLockTable(db: SqliteLeaseDb, table: string = DEFAULT_LEASE_TABLE) {
 return observeLock('store.ddl', async () => {
      try {
  await db.run(sql.raw(leaseTableSql(table)));

        return;
      } catch (error) { return storeFailure(error, 'ddl'); }

 });
}

// SQLite returns integers as numbers and has no boolean: 0 is false.
const acquireRowSchema = z.object({ generation: z.string(), expires_ms: z.string() });
const conflictRowSchema = z.object({ conflict: z.number().transform(value => value !== 0) });

/** SQLITE_BUSY and its extended codes (261, 517, 773): another connection holds the write lock. */
const busyCodeSchema = z.union([
  z.object({ rawCode: z.literal([5, 261, 517, 773]) }),
  z.object({ code: z.string().startsWith('SQLITE_BUSY') }),
]);
/** libSQL's error, bare or as the `cause` of Drizzle's `DrizzleQueryError`. */
const busyErrorSchema = z.union([busyCodeSchema, z.object({ cause: busyCodeSchema })]);

/** One acquire attempt. SQLITE_BUSY means nothing ran, so it is "not now", never an error. */
async function unlessBusy(attempt: () => Promise<Grant | undefined>): Promise<Grant | undefined> {
  try {
    return await attempt();
  } catch (error) {
    if (busyErrorSchema.safeParse(error).success) return;
    throw error;
  }
}

/** Now, in ms since the epoch, from SQLite's clock. It is one value for the whole statement. */
const NOW_MS = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/** A number bound as an integer, so sums and JSON stay integers. */
const int = (value: number): SQL => sql`cast(${value} as integer)`;

/** The holders in `l.holders` whose lease has not run out. */
const LIVE_HOLDERS = sql`(SELECT json_group_array(json(h.value)) FROM json_each(l.holders) AS h WHERE h.value ->> 'e' > ${NOW_MS})`;
const LIVE_WEIGHT = sql`(SELECT coalesce(sum(h.value ->> 'w'), 0) FROM json_each(l.holders) AS h WHERE h.value ->> 'e' > ${NOW_MS})`;

export function sqliteLease(db: SqliteLeaseDb, options: SqliteLeaseOptions): SqliteLeaseStore {
  const ttlMs = parseDuration(options.ttl);
  if (!(ttlMs >= MIN_LEASE_TTL_MS)) {
    throw new LockError({
      code: 'config',
      message: `lease ttl ${ttlMs} ms is below the renewal floor of ${MIN_LEASE_TTL_MS} ms`,
      remediation: `Use a ttl of at least ${MIN_LEASE_TTL_MS} ms.`,
    });
  }
  const table = tableIdentifier(options.table ?? DEFAULT_LEASE_TABLE);

  /**
   * Semaphore protocol. One row per key; its live holders are the JSON array in the row
   * (`[{ t: token, w: weight, f: fence, e: expiry ms }]`). SQLite runs one writer at a time,
   * so the capacity test in each statement sees every grant already made.
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
      const leaseMs = req.ttlMs ?? ttlMs;
      const holder = (fence: SQL): SQL =>
        sql`json_object('t', ${token}, 'w', ${int(weight)}, 'f', ${fence}, 'e', ${NOW_MS} + ${int(leaseMs)})`;
      return await unlessBusy(async () => {
        const [row] = await db.all(sql`
          INSERT INTO ${table} AS l (key, generation, expires_at, permits_limit, holders)
          VALUES (${key.full}, 1, ${NOW_MS} + ${int(leaseMs)}, ${int(limit)}, json_array(${holder(sql`1`)}))
          ON CONFLICT (key) DO UPDATE
            SET generation = l.generation + 1,
                permits_limit = ${int(limit)},
                holders = json_insert(${LIVE_HOLDERS}, '$[#]', ${holder(sql`l.generation + 1`)})
            WHERE ${LIVE_WEIGHT} + ${int(weight)} <= ${int(limit)}
              AND (${LIVE_WEIGHT} = 0 OR l.permits_limit = ${int(limit)})
          RETURNING cast(generation AS text) AS generation, cast(holders ->> '$[#-1].e' AS text) AS expires_ms
        `);
        if (row !== undefined) {
          const parsed = acquireRowSchema.parse(row);
          return { key, token, fence: lockFenceSchema.parse(BigInt(parsed.generation)), expiresAt: Number(parsed.expires_ms) };
        }
        // Refused: full, or the limit disagrees with the holders'. Only the second is an error.
        const [checked] = await db.all(sql`
          SELECT (${LIVE_WEIGHT} > 0 AND l.permits_limit IS NOT ${int(limit)}) AS conflict
            FROM ${table} AS l WHERE l.key = ${key.full}
        `);
        if (checked !== undefined && conflictRowSchema.parse(checked).conflict) {
          throw new LockError({
            code: 'config',
            message: `the semaphore is held with a different limit than ${limit}`,
            remediation: 'Declare one limit per semaphore key; a new limit is accepted once no hold is left.',
          });
        }
        return;
      });
    
      } catch (error) { return storeFailure(error, 'acquire'); }

 });
},
    async release(grant: Grant) {
 return observeLock('store.release', async () => {
      try {
      const rows = await db.all(sql`
        UPDATE ${table} AS l
          SET holders = (SELECT json_group_array(json(h.value)) FROM json_each(l.holders) AS h WHERE h.value ->> 't' <> ${grant.token})
          WHERE l.key = ${grant.key.full}
            AND EXISTS (SELECT 1 FROM json_each(l.holders) AS h WHERE h.value ->> 't' = ${grant.token})
          RETURNING key
      `);
      return rows.length > 0 ? 'released' : 'not-owner';
    
      } catch (error) { return storeFailure(error, 'release'); }

 });
},
    async extend(grant: Grant, extendMs: number) {
 return observeLock('store.extend', async () => {
      try {
      const rows = await db.all(sql`
        UPDATE ${table} AS l
          SET holders = (
            SELECT json_group_array(CASE WHEN h.value ->> 't' = ${grant.token}
                                         THEN json_set(h.value, '$.e', ${NOW_MS} + ${int(extendMs)})
                                         ELSE json(h.value) END)
              FROM json_each(l.holders) AS h)
          WHERE l.key = ${grant.key.full}
            AND EXISTS (SELECT 1 FROM json_each(l.holders) AS h
                         WHERE h.value ->> 't' = ${grant.token} AND h.value ->> 'e' > ${NOW_MS})
          RETURNING 1 AS ok
      `);
      return rows.length > 0;
    
      } catch (error) { return storeFailure(error, 'extend'); }

 });
},
  };

  return {
    name: 'sqlite-lease',
    guarantees: sqliteLeaseGuarantees,
    permits,
    ttlMs,
    async acquire(key: Key, req: AcquireRequest) {
 return observeLock('store.acquire', async () => {
      try {
      const leaseMs = req.ttlMs ?? ttlMs;
      return await unlessBusy(async () => {
        const [row] = await db.all(sql`
          INSERT INTO ${table} AS lease (key, token, generation, expires_at)
          VALUES (${key.full}, ${req.token}, 1, ${NOW_MS} + ${int(leaseMs)})
          ON CONFLICT (key) DO UPDATE
            SET token = excluded.token,
                generation = lease.generation + 1,
                expires_at = excluded.expires_at
            WHERE lease.token IS NULL OR lease.expires_at <= ${NOW_MS}
          RETURNING cast(generation AS text) AS generation, cast(expires_at AS text) AS expires_ms
        `);
        if (row === undefined) return;
        const parsed = acquireRowSchema.parse(row);
        return { key, token: req.token, fence: lockFenceSchema.parse(BigInt(parsed.generation)), expiresAt: Number(parsed.expires_ms) };
      });
    
      } catch (error) { return storeFailure(error, 'acquire'); }

 });
},
    async release(grant: Grant) {
 return observeLock('store.release', async () => {
      try {
      // The row stays: `generation` must survive.
      const rows = await db.all(sql`
        UPDATE ${table}
          SET token = NULL, expires_at = ${NOW_MS}
          WHERE key = ${grant.key.full} AND token = ${grant.token}
          RETURNING key
      `);
      return rows.length > 0 ? 'released' : 'not-owner';
    
      } catch (error) { return storeFailure(error, 'release'); }

 });
},
    async extend(grant: Grant, extendMs: number) {
 return observeLock('store.extend', async () => {
      try {
      const rows = await db.all(sql`
        UPDATE ${table}
          SET expires_at = ${NOW_MS} + ${int(extendMs)}
          WHERE key = ${grant.key.full} AND token = ${grant.token} AND expires_at > ${NOW_MS}
          RETURNING 1 AS ok
      `);
      return rows.length > 0;
    
      } catch (error) { return storeFailure(error, 'extend'); }

 });
},
  };
}
