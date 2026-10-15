/**
 * PostgreSQL advisory locks: "run this unless another replica already is".
 *
 * Built for jobs that may run longer than their tick (embedding a backlog,
 * re-clustering, sending a digest). A second run would do the work twice, so
 * it skips instead of queueing. The lock lives as long as the job — not a
 * lease that expires after 60 seconds while the job is still going.
 *
 * Session pinning: advisory locks belong to a database SESSION, and a pool
 * hands each query to whichever connection is free — lock and unlock could
 * land on different sessions, and the lock would leak. So acquire → run →
 * release happens inside ONE `transaction`, which pins one connection. The
 * job itself still uses the pool (the pinned connection only holds the lock),
 * so a pool needs at least two connections. Unlocking runs on the pinned
 * session before the transaction ends; session locks are not undone by
 * COMMIT or ROLLBACK, so the explicit unlock is what releases it.
 *
 * Moved from Avocabo's `withCronLock`; the key format is the same
 * (`hashtext('<namespace>:<key>')`), so a running old replica and a new one
 * still exclude each other during a deploy.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { getLogger } from '@arki/log';

const log = getLogger('arki:db:lock');

/** The least a database must offer: a transaction whose handle runs raw SQL (node-postgres, PGlite, …). */
export type LockableDb = {
  transaction<T>(run: (tx: { execute(query: SQL): PromiseLike<unknown> }) => Promise<T>): Promise<T>;
};

/**
 * How a locked run went: it ran (with the job's result), or another holder
 * had the lock. `{ tryRun }` with this result is the lock port `@arki/schedule`
 * names `Locker`; a future `@arki/lock` can implement the same shape.
 */
export type LockRun<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `{ rows: [...] }` (node-postgres, PGlite) or a bare array (postgres.js): read the first row's `acquired`. */
function wasAcquired(result: unknown): boolean {
  const rows: unknown = Array.isArray(result) ? result : isRecord(result) ? result['rows'] : undefined;
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  return isRecord(first) && first['acquired'] === true;
}

/**
 * Run `fn` under the advisory lock `key`; skip it when the lock is held.
 * `key` is hashed with `hashtext` (32 bits): give every app its own prefix
 * (see {@link advisoryLocks}), or two apps sharing a Postgres instance can
 * block each other's jobs.
 */
export async function withAdvisoryLock<T>(db: LockableDb, key: string, fn: () => Promise<T>): Promise<LockRun<T>> {
  return db.transaction(async (tx): Promise<LockRun<T>> => {
    const acquired = wasAcquired(await tx.execute(sql`select pg_try_advisory_lock(hashtext(${key})) as acquired`));
    if (!acquired) {
      log.debug('lock {key} is held; skipping the run', { key });
      return { ran: false };
    }
    try {
      // The pinned connection sits idle while the job works on the pool. Without this,
      // a server-side idle timeout would close it mid-job and quietly drop the lock.
      // SET LOCAL ends with the transaction, so the pool's setting comes back.
      await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`);
      return { ran: true, value: await fn() };
    } finally {
      await tx.execute(sql`select pg_advisory_unlock(hashtext(${key}))`);
    }
  });
}

/**
 * Advisory locks for one app: every key becomes `<namespace>:<key>`. Use the
 * app's name as the namespace — Postgres instances get shared, and hashed
 * keys from two apps could otherwise collide.
 *
 * In a Dot app, mount `advisoryLocks` from `@arki/db/dot` instead: it builds
 * this at boot from the app's database handle.
 */
export function advisoryLocks(db: LockableDb, options: { readonly namespace: string }) {
  return {
    /** Run `fn` if nobody holds `key`; otherwise skip it. Errors from `fn` propagate after the lock is released. */
    tryRun: <T>(key: string, fn: () => Promise<T>) => withAdvisoryLock(db, `${options.namespace}:${key}`, fn),
  };
}
