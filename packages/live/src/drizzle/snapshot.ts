import type { PgTransactionConfig } from 'drizzle-orm/pg-core';

import type { SnapshotRunner } from '../runner.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';

/** The one transaction shape a snapshot opens: a single Postgres snapshot that cannot write. */
const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const satisfies PgTransactionConfig;

/** A database that can open a configured transaction: any Drizzle Postgres database (node-postgres, PGlite, …). */
export type SnapshotDatabase<Tx> = {
  transaction<T>(run: (tx: Tx) => Promise<T>, config: typeof SNAPSHOT): Promise<T>;
};

/**
 * A transaction handle has `rollback()`; a database does not. A nested
 * Drizzle transaction is a savepoint inside the outer snapshot, and it takes
 * no isolation level, so `snapshot()` refuses one at compile time and at run time.
 */
type NotATransaction = { readonly rollback?: never };

/**
 * Opens one `REPEATABLE READ READ ONLY` transaction per call and binds the
 * readers to it, so every read of one call sees the same snapshot. A write
 * inside it fails in Postgres. `Readers` is inferred from `bind`; with
 * `repos()` from `@arki/db/dot` it is the repo set `withTx(tx)` returns.
 */
export function snapshot<Tx, Readers>(
  db: SnapshotDatabase<Tx> & NotATransaction,
  bind: (tx: Tx) => Readers,
): SnapshotRunner<Readers> {
  if ('rollback' in db) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      'snapshot() got a transaction handle; a nested transaction is a savepoint, not a new snapshot',
      'Pass the root database (the `db` need), not a `tx`.',
    );
  }
  return run => db.transaction(tx => run(bind(tx)), SNAPSHOT);
}
