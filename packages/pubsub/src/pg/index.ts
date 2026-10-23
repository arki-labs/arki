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

import type { OnMessage, TransactionalPubSub } from '../types.js';
import { checkChannel, checkMessage, checkOpen } from '../limits.js';

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

/** One heard channel: its callbacks, and the listen that resolves with the function that stops it. */
type Channel = { readonly callbacks: Set<OnMessage>; readonly listening: Promise<() => Promise<void>> };

/** A pubsub over Postgres LISTEN/NOTIFY. */
export function pgPubSub(options: PgPubSubOptions): TransactionalPubSub<PgTransaction> {
  const { pool } = options;
  const channels = new Map<string, Channel>();
  let closed = false;

  async function stop(name: string, channel: Channel): Promise<void> {
    if (channels.get(name) === channel) channels.delete(name);
    let unlisten: () => Promise<void>;
    try {
      unlisten = await channel.listening;
    } catch {
      return; // The listen never started (its subscriber got the error), so nothing to stop.
    }
    await unlisten();
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
    async subscribe(name, onMessage) {
      checkOpen(closed, 'pg');
      checkChannel(name);
      let channel = channels.get(name);
      if (channel === undefined) {
        log.debug('listening on {channel}', { channel: name });
        const callbacks = new Set<OnMessage>();
        const listening = listenOnPool(
          pool,
          name,
          options.listen,
        )(payload => {
          for (const callback of callbacks) {
            try {
              callback(payload);
            } catch (error) {
              log.warn('a subscriber on {channel} threw: {message}', {
                channel: name,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        });
        channel = { callbacks, listening };
        channels.set(name, channel);
      }
      // Wrapped, so the same function subscribed twice is two subscriptions.
      const subscription: OnMessage = payload => onMessage(payload);
      channel.callbacks.add(subscription);
      const leave = async (): Promise<void> => {
        if (!channel.callbacks.delete(subscription) || channel.callbacks.size > 0) return;
        await stop(name, channel);
      };
      try {
        await channel.listening;
      } catch (error) {
        await leave();
        throw error;
      }
      return leave;
    },
    async close() {
      if (closed) return;
      closed = true;
      const open = [...channels];
      for (const [, channel] of open) channel.callbacks.clear();
      await Promise.all(open.map(([name, channel]) => stop(name, channel)));
      log.debug('pg pubsub closed');
    },
  };
}
