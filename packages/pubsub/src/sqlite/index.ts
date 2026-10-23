/**
 * `@arki/pubsub/sqlite`: messages in a SQLite table, read by polling. Works on
 * libSQL (`createLibsqlDb` from `@arki/db/libsql`) and publishes inside a
 * transaction with `publishIn`.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';
import { and, asc, gt, inArray, lt, max, sql } from 'drizzle-orm';

import { unrefTimer } from '@arki/db/sqlite';
import { sqliteNowMs } from '@arki/db/sqlite';
import { getLogger } from '@arki/log';

import type { OnMessage, TransactionalPubSub } from '../types.js';
import type { PubsubTable } from './table.js';
import { PubSubError } from '../errors.js';
import { checkChannel, checkMessage, checkOpen } from '../limits.js';
import { pubsubTable } from './table.js';

export type { PubsubTable } from './table.js';
export { pubsubTable } from './table.js';

const log = getLogger('arki:pubsub');

/** Any async Drizzle SQLite database or transaction; libSQL is the one `@arki/db` supports. */
export type SqlitePubSubDb = SQLiteAsyncDatabase<'async', unknown, AnyRelations>;

export type SqlitePubSubOptions<TDb> = {
  /** The Drizzle database the table lives in. Subscribers read through it; `publish` writes through it. */
  readonly db: TDb;
  /** The table from `pubsubTable()`. Default: `pubsubTable()`, named `arki_pubsub`. */
  readonly table?: PubsubTable;
  /** How often subscribers read new rows, in milliseconds. Default 250. */
  readonly intervalMs?: number;
  /** Rows older than this many milliseconds are deleted by the next publisher. Default 60000. */
  readonly retainMs?: number;
};

/** How many rows one poll reads at most; the next poll goes on from there. */
const POLL_BATCH = 1000;

/** The transaction type `db.transaction(fn)` hands to `fn`, read off the database. */
type TransactionOf<TDb extends SqlitePubSubDb> = Parameters<Parameters<TDb['transaction']>[0]>[0];

/** One subscription: its callback, and the newest id when it subscribed (it sees only later ids). */
type Subscription = { readonly onMessage: OnMessage; readonly after: number };

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PubSubError({
      code: 'config',
      message: `sqlitePubSub(): ${name} must be a positive number of milliseconds, got ${value}`,
      remediation: `Pass a positive ${name}, or leave it out for the default.`,
    });
  }
  return value;
}

/**
 * A pubsub over a SQLite message table. Each subscriber starts at the newest row
 * when it subscribes; one loop per pubsub reads `id > cursor` for the subscribed
 * channels every `intervalMs`. `publishIn(tx, …)` inserts the row in your
 * transaction: it is seen at commit and never if the transaction rolls back.
 * SQLite has one writer, so ids commit in order and no row is skipped.
 */
export function sqlitePubSub<TDb extends SqlitePubSubDb>(
  options: SqlitePubSubOptions<TDb>,
): TransactionalPubSub<TransactionOf<TDb>>;
export function sqlitePubSub(options: SqlitePubSubOptions<SqlitePubSubDb>): TransactionalPubSub<SqlitePubSubDb> {
  const { db } = options;
  const table = options.table ?? pubsubTable();
  const intervalMs = positive('intervalMs', options.intervalMs ?? 250);
  const retainMs = positive('retainMs', options.retainMs ?? 60_000);

  const channels = new Map<string, Set<Subscription>>();
  let cursor = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;

  async function insert(handle: SqlitePubSubDb, channel: string, payload: string): Promise<void> {
    await handle.insert(table).values({ channel, payload });
    await handle.delete(table).where(lt(table.createdAt, sql`${sqliteNowMs} - ${retainMs}`));
  }

  async function pollOnce(): Promise<void> {
    if (channels.size === 0) return;
    const rows = await db
      .select({ id: table.id, channel: table.channel, payload: table.payload })
      .from(table)
      .where(and(gt(table.id, cursor), inArray(table.channel, [...channels.keys()])))
      .orderBy(asc(table.id))
      .limit(POLL_BATCH)
      .catch((error: unknown) => {
        log.debug('poll failed, trying again in {intervalMs} ms: {message}', {
          intervalMs,
          message: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
    for (const row of rows) {
      cursor = Math.max(cursor, row.id);
      for (const subscription of channels.get(row.channel) ?? []) {
        if (row.id <= subscription.after || !channels.get(row.channel)?.has(subscription)) continue;
        try {
          subscription.onMessage(row.payload);
        } catch (error) {
          log.warn('a subscriber on {channel} threw: {message}', {
            channel: row.channel,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  function schedule(): void {
    if (closed || timer !== undefined || polling !== undefined || channels.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      polling = pollOnce().finally(() => {
        polling = undefined;
        schedule();
      });
    }, intervalMs);
    unrefTimer(timer);
  }

  return {
    async publish(channel, payload) {
      checkOpen(closed, 'sqlite');
      checkMessage(channel, payload);
      await insert(db, channel, payload);
    },
    async publishIn(tx, channel, payload) {
      checkOpen(closed, 'sqlite');
      checkMessage(channel, payload);
      await insert(tx, channel, payload);
    },
    async subscribe(channel, onMessage) {
      checkOpen(closed, 'sqlite');
      checkChannel(channel);
      const [newest] = await db.select({ id: max(table.id) }).from(table);
      const after = newest?.id ?? 0;
      checkOpen(closed, 'sqlite');
      // Nobody listened: start the shared cursor here. Otherwise it is at or below `after` already.
      if (channels.size === 0) {
        cursor = Math.max(cursor, after);
        log.debug('poll loop started, every {intervalMs} ms', { intervalMs });
      }
      const subscription: Subscription = { onMessage, after };
      const set = channels.get(channel) ?? new Set();
      set.add(subscription);
      channels.set(channel, set);
      schedule();
      return async () => {
        set.delete(subscription);
        if (set.size === 0 && channels.get(channel) === set) channels.delete(channel);
        if (channels.size > 0 || timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        log.debug('poll loop stopped: no subscribers');
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      channels.clear();
      await polling;
      log.debug('sqlite pubsub closed');
    },
  };
}
