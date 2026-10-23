/**
 * `@arki/pubsub/redis`: Redis `PUBLISH`, and `SUBSCRIBE` on a second connection
 * (`client.duplicate()`), since a subscribed Redis connection can run nothing
 * else. It has no `publishIn`: Redis cannot join a database transaction.
 */
import type { Redis } from 'ioredis';

import { getLogger } from '@arki/log';

import type { Subscription } from '../subscribers.js';
import type { PubSub } from '../types.js';
import { checkChannel, checkMessage, checkOpen } from '../limits.js';
import { createSubscribers, deliver } from '../subscribers.js';

const log = getLogger('arki:pubsub');

export type RedisPubSubOptions = {
  /** An ioredis client. It publishes; a duplicate of it subscribes. `close()` closes only the duplicate. */
  readonly client: Redis;
};

/** A pubsub over Redis pub/sub. */
export function redisPubSub(options: RedisPubSubOptions): PubSub {
  const { client } = options;
  const subscribers = createSubscribers();
  /** One `SUBSCRIBE` per channel, in flight or done. */
  const subscribing = new Map<string, Promise<unknown>>();
  let subscriber: Redis | undefined;
  let closed = false;

  /** The subscriber connection, made on the first subscribe. */
  function connection(): Redis {
    if (subscriber) return subscriber;
    const created = client.duplicate();
    created.on('message', (channel, payload) => deliver(subscribers.of(channel), payload));
    created.on('error', (error: Error) => {
      log.debug('redis subscriber connection error: {message}', { message: error.message });
    });
    log.debug('redis subscriber connection opened');
    subscriber = created;
    return created;
  }

  async function leave(subscription: Subscription): Promise<void> {
    if (!subscribers.remove(subscription)) return;
    subscribing.delete(subscription.channel);
    if (!closed) await subscriber?.unsubscribe(subscription.channel);
  }

  return {
    async publish(channel, payload) {
      checkOpen(closed, 'redis');
      checkMessage(channel, payload);
      await client.publish(channel, payload);
    },
    async subscribe(channel, onMessage) {
      checkOpen(closed, 'redis');
      checkChannel(channel);
      const { subscription, first } = subscribers.add(channel, onMessage);
      if (first) subscribing.set(channel, connection().subscribe(channel));
      try {
        await subscribing.get(channel);
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
      subscribing.clear();
      if (subscriber) await subscriber.quit();
      log.debug('redis pubsub closed');
    },
  };
}
