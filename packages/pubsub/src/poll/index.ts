/**
 * `@arki/pubsub/poll`: messages in a database table, read by polling. Works on
 * Postgres and SQLite, and publishes inside a transaction with `publishIn`.
 */
import { is } from 'drizzle-orm';
import { PgAsyncDatabase, PgTable } from 'drizzle-orm/pg-core';
import { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';

import type { TransactionalPubSub } from '../types.js';
import type { PgPollDb } from './pg.js';
import type { SqlitePollDb } from './sqlite.js';
import type { PubsubTable } from './table.js';
import { PubSubError } from '../errors.js';
import { pollEngine } from './engine.js';
import { pgPollQueries } from './pg.js';
import { sqlitePollQueries } from './sqlite.js';

export type { PgPollDb } from './pg.js';
export type { SqlitePollDb } from './sqlite.js';
export type { PubsubRow, PubsubTable } from './table.js';
export { pubsubTable } from './table.js';

export type PollPubSubOptions<TDb, TTable> = {
  /** The Drizzle database the table lives in. Subscribers read through it; `publish` writes through it. */
  readonly db: TDb;
  /** The table from `pubsubTable(c)`, built with the same dialect's column kit as `db`. */
  readonly table: TTable;
  /** How often subscribers read new rows, in milliseconds. Default 250. */
  readonly intervalMs?: number;
  /** Rows older than this many milliseconds are deleted by the next publisher. Default 60000. */
  readonly retainMs?: number;
};

/** The transaction type `db.transaction(fn)` hands to `fn`, read off the database. */
type TransactionOf<TDb extends PgPollDb | SqlitePollDb> = Parameters<Parameters<TDb['transaction']>[0]>[0];

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PubSubError({
      code: 'config',
      message: `pollPubSub(): ${name} must be a positive number of milliseconds, got ${value}`,
      remediation: `Pass a positive ${name}, or leave it out for the default.`,
    });
  }
  return value;
}

/**
 * A pubsub over a message table. Each subscriber starts at the newest row when it
 * subscribes and reads `id > cursor` for its channels every `intervalMs`.
 * `publishIn(tx, …)` inserts the row in your transaction: it is seen at commit
 * and never if the transaction rolls back. On Postgres a row whose transaction
 * commits after a later id was read can be missed (best effort, like NOTIFY); use
 * `pgPubSub` there when you can.
 */
export function pollPubSub<TDb extends PgPollDb>(
  options: PollPubSubOptions<TDb, PubsubTable<'pg'>>,
): TransactionalPubSub<TransactionOf<TDb>>;
export function pollPubSub<TDb extends SqlitePollDb>(
  options: PollPubSubOptions<TDb, PubsubTable<'sqlite'>>,
): TransactionalPubSub<TransactionOf<TDb>>;
export function pollPubSub(
  options: PollPubSubOptions<PgPollDb | SqlitePollDb, PubsubTable<'pg'> | PubsubTable<'sqlite'>>,
): TransactionalPubSub<PgPollDb> | TransactionalPubSub<SqlitePollDb> {
  const intervalMs = positive('intervalMs', options.intervalMs ?? 250);
  const retainMs = positive('retainMs', options.retainMs ?? 60_000);
  const { db, table } = options;
  // Drizzle's own class checks (what `dialectOf` reads) narrow the table, then the database, to one dialect.
  if (is(table, PgTable)) {
    if (is(db, PgAsyncDatabase)) return pollEngine(pgPollQueries(db, table, retainMs), intervalMs);
  } else if (is(db, SQLiteAsyncDatabase)) {
    return pollEngine(sqlitePollQueries(db, table, retainMs), intervalMs);
  }
  throw new PubSubError({
    code: 'config',
    message: 'pollPubSub(): db and table are not both Postgres or both SQLite',
    remediation: 'Build the table with the column kit of the same dialect as db (pgColumns() or sqliteColumns()).',
  });
}
