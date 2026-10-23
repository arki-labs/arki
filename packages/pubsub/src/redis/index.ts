/**
 * `@arki/pubsub/redis`: Redis `PUBLISH`, and `SUBSCRIBE` on a second connection
 * (`client.duplicate()`), since a subscribed Redis connection can run nothing
 * else. It has no `publishIn`: Redis cannot join a database transaction.
 */
import type { Redis } from 'ioredis';

import { getLogger } from '@arki/log';

import type { OnMessage, PubSub } from '../types.js';
import { checkChannel, checkMessage, checkOpen } from '../limits.js';

const log = getLogger('arki:pubsub');

export type RedisPubSubOptions = {
  /** An ioredis client. It publishes; a duplicate of it subscribes. `close()` closes only the duplicate. */
  readonly client: Redis;
};

/** One subscribed channel: its callbacks, and its `SUBSCRIBE` (in flight or done). */
type Channel = { readonly callbacks: Set<OnMessage>; readonly subscribing: Promise<unknown> };

/** A pubsub over Redis pub/sub. */
export function redisPubSub(options: RedisPubSubOptions): PubSub {
  const { client } = options;
  const channels = new Map<string, Channel>();
  let subscriber: Redis | undefined;
  let closed = false;

  /** The subscriber connection, made on the first subscribe. */
  function connection(): Redis {
    if (subscriber) return subscriber;
    const created = client.duplicate();
    created.on('message', (name, payload) => {
      for (const callback of channels.get(name)?.callbacks ?? []) {
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
    created.on('error', (error: Error) => {
      log.debug('redis subscriber connection error: {message}', { message: error.message });
    });
    log.debug('redis subscriber connection opened');
    subscriber = created;
    return created;
  }

  return {
    async publish(channel, payload) {
      checkOpen(closed, 'redis');
      checkMessage(channel, payload);
      await client.publish(channel, payload);
    },
    async subscribe(name, onMessage) {
      checkOpen(closed, 'redis');
      checkChannel(name);
      let channel = channels.get(name);
      if (channel === undefined) {
        channel = { callbacks: new Set(), subscribing: connection().subscribe(name) };
        channels.set(name, channel);
      }
      // Wrapped, so the same function subscribed twice is two subscriptions.
      const subscription: OnMessage = payload => onMessage(payload);
      channel.callbacks.add(subscription);
      const leave = async (): Promise<void> => {
        if (!channel.callbacks.delete(subscription) || channel.callbacks.size > 0) return;
        if (channels.get(name) === channel) channels.delete(name);
        if (!closed) await subscriber?.unsubscribe(name);
      };
      try {
        await channel.subscribing;
      } catch (error) {
        await leave();
        throw error;
      }
      return leave;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const channel of channels.values()) channel.callbacks.clear();
      channels.clear();
      if (subscriber) await subscriber.quit();
      log.debug('redis pubsub closed');
    },
  };
}
