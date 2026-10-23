/**
 * The poll loop, the same on every dialect. It takes the dialect's queries
 * (`./pg.ts` or `./sqlite.ts`) and never builds SQL itself.
 */
import { unrefTimer } from '@arki/db/pg';
import { getLogger } from '@arki/log';

import type { Subscription } from '../subscribers.js';
import type { TransactionalPubSub } from '../types.js';
import type { PubsubRow } from './table.js';
import { checkChannel, checkMessage, checkOpen } from '../limits.js';
import { createSubscribers, deliver } from '../subscribers.js';

const log = getLogger('arki:pubsub');

/** What a dialect's query file gives the loop: plain Drizzle queries bound to one database and table. */
export type PollQueries<Tx> = {
  /** Inserts the message on the root database, then deletes the rows older than the retention. */
  publish(channel: string, payload: string): Promise<void>;
  /** The same, inside `tx`. */
  publishIn(tx: Tx, channel: string, payload: string): Promise<void>;
  /** The largest id in the table, or 0 when it is empty. */
  newestId(): Promise<number>;
  /** The rows of `channels` with an id above `after`, oldest first. */
  read(after: number, channels: string[]): Promise<PubsubRow[]>;
};

/** One poll loop per pubsub, shared by all its subscriptions; it runs only while someone listens. */
export function pollEngine<Tx>(queries: PollQueries<Tx>, intervalMs: number): TransactionalPubSub<Tx> {
  const subscribers = createSubscribers();
  /** Each subscription sees only ids above the newest id when it subscribed. */
  const startsAfter = new Map<Subscription, number>();
  let cursor = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;

  async function pollOnce(): Promise<void> {
    const channels = subscribers.channels();
    if (channels.length === 0) return;
    let rows: PubsubRow[];
    try {
      rows = await queries.read(cursor, channels);
    } catch (error) {
      log.debug('poll failed, trying again in {intervalMs} ms: {message}', {
        intervalMs,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const row of rows) {
      cursor = Math.max(cursor, row.id);
      const receivers = subscribers.of(row.channel).filter(subscription => {
        const after = startsAfter.get(subscription);
        return after !== undefined && row.id > after;
      });
      deliver(receivers, row.payload);
    }
  }

  function schedule(): void {
    if (closed || timer !== undefined || polling !== undefined || subscribers.channels().length === 0) return;
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
      checkOpen(closed, 'poll');
      checkMessage(channel, payload);
      await queries.publish(channel, payload);
    },
    async publishIn(tx, channel, payload) {
      checkOpen(closed, 'poll');
      checkMessage(channel, payload);
      await queries.publishIn(tx, channel, payload);
    },
    async subscribe(channel, onMessage) {
      checkOpen(closed, 'poll');
      checkChannel(channel);
      const newest = await queries.newestId();
      checkOpen(closed, 'poll');
      // Nobody listened: start the shared cursor here. Otherwise it is at or below `newest` already.
      if (subscribers.channels().length === 0) cursor = Math.max(cursor, newest);
      const { subscription } = subscribers.add(channel, onMessage);
      startsAfter.set(subscription, newest);
      if (subscribers.channels().length === 1) log.debug('poll loop started, every {intervalMs} ms', { intervalMs });
      schedule();
      return async () => {
        subscribers.remove(subscription);
        startsAfter.delete(subscription);
        if (subscribers.channels().length > 0 || timer === undefined) return;
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
      subscribers.clear();
      startsAfter.clear();
      await polling;
      log.debug('poll pubsub closed');
    },
  };
}
