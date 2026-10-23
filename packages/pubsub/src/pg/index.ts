/**
 * `@arki/pubsub/pg`: Postgres LISTEN/NOTIFY. `publish` runs `pg_notify` on the
 * pool; `publishIn(tx, …)` runs it inside your transaction, so Postgres sends it
 * at commit and drops it on rollback. Each channel is heard on one dedicated
 * client of the pool (`listenOnPool` from `@arki/db/pg`), shared by all
 * subscriptions of this pubsub.
 *
 * The pool must hand out real sessions. Behind a transaction pooler
 * (PgBouncer in transaction mode, Supavisor :6543, Neon's `-pooler` host) LISTEN
 * is lost between statements: connect to the direct host (`sessionPool` from
 * `@arki/db/dot`).
 */
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncTransaction, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import type { ListenOptions, ListenPool } from '@arki/db/pg';
import { listenOnPool } from '@arki/db/pg';
import { getLogger } from '@arki/log';

import type { Subscription } from '../subscribers.js';
import type { TransactionalPubSub } from '../types.js';
import { checkChannel, checkMessage, checkOpen } from '../limits.js';
import { createSubscribers, deliver } from '../subscribers.js';

const log = getLogger('arki:pubsub');

/** A `pg` pool (`new pg.Pool(...)`, or a Drizzle node-postgres database's `$client`): it hands out listen clients and runs `pg_notify`. */
export type PgPubSubPool = ListenPool & { query(text: string, values: unknown[]): Promise<unknown> };

/** Any Drizzle Postgres transaction (node-postgres, postgres.js, PGlite, …). */
export type PgTransaction = PgAsyncTransaction<PgQueryResultHKT, AnyRelations>;

export type PgPubSubOptions = {
  /** A session pool on the direct host, never a transaction pooler. Not closed by `close()`. */
  readonly pool: PgPubSubPool;
  /** Reconnect and health-check timing of the listen clients. */
  readonly listen?: ListenOptions;
};

/** A pubsub over Postgres LISTEN/NOTIFY. */
export function pgPubSub(options: PgPubSubOptions): TransactionalPubSub<PgTransaction> {
  const { pool } = options;
  const subscribers = createSubscribers();
  /** One listener per channel; each resolves with the function that stops it. */
  const listeners = new Map<string, Promise<() => Promise<void>>>();
  let closed = false;

  async function stopListener(channel: string): Promise<void> {
    const listening = listeners.get(channel);
    if (listening === undefined) return;
    listeners.delete(channel);
    let stop: () => Promise<void>;
    try {
      stop = await listening;
    } catch {
      return; // The listen never started (its subscriber got the error), so nothing to stop.
    }
    await stop();
  }

  async function leave(subscription: Subscription): Promise<void> {
    if (subscribers.remove(subscription)) await stopListener(subscription.channel);
  }

  return {
    async publish(channel, payload) {
      checkOpen(closed, 'pg');
      checkMessage(channel, payload);
      await pool.query('select pg_notify($1, $2)', [channel, payload]);
    },
    async publishIn(tx, channel, payload) {
      checkOpen(closed, 'pg');
      checkMessage(channel, payload);
      await tx.execute(sql`select pg_notify(${channel}, ${payload})`);
    },
    async subscribe(channel, onMessage) {
      checkOpen(closed, 'pg');
      checkChannel(channel);
      const { subscription, first } = subscribers.add(channel, onMessage);
      if (first) {
        log.debug('listening on {channel}', { channel });
        listeners.set(
          channel,
          listenOnPool(pool, channel, options.listen)(payload => deliver(subscribers.of(channel), payload)),
        );
      }
      try {
        await listeners.get(channel);
      } catch (error) {
        await leave(subscription);
        throw error;
      }
      return () => leave(subscription);
    },
    async close() {
      if (closed) return;
      closed = true;
      subscribers.clear();
      await Promise.all([...listeners.keys()].map(channel => stopListener(channel)));
      log.debug('pg pubsub closed');
    },
  };
}
