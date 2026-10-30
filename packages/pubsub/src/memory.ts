/**
 * `@arki/pubsub/memory`: in-process fan-out, for tests and one-process apps.
 * It has no `publishIn`: nothing here can join a database transaction.
 */
import { getLogger } from '@arki/log';

import type { OnMessage, PubSub } from './types.js';
import { deliver } from './deliver.js';
import { checkChannel, checkMessage, checkOpen } from './limits.js';

const log = getLogger('arki:pubsub');

/**
 * A pubsub inside this process. Each call makes its own, separate bus.
 * Messages arrive on a later microtask, never inside `publish`, in the order they were published.
 */
export function memoryPubSub(): PubSub {
  /** The callbacks of each channel. A callback leaves its set when it unsubscribes. */
  const channels = new Map<string, Set<OnMessage>>();
  let closed = false;

  return {
    async publish(channel, payload) {
      checkOpen(closed, 'memory');
      checkMessage(channel, payload);
      // Taken now: a subscriber that joins before the microtask runs did not see this publish.
      const receivers = [...(channels.get(channel) ?? [])];
      queueMicrotask(() => {
        for (const onMessage of receivers) {
          if (!channels.get(channel)?.has(onMessage)) continue; // unsubscribed meanwhile
          deliver(channel, onMessage, payload);
        }
      });
    },
    async subscribe(channel, onMessage) {
      checkOpen(closed, 'memory');
      checkChannel(channel);
      // Wrapped, so the same function subscribed twice is two subscriptions.
      const subscription: OnMessage = payload => onMessage(payload);
      const set = channels.get(channel) ?? new Set();
      set.add(subscription);
      channels.set(channel, set);
      return async () => {
        set.delete(subscription);
        if (set.size === 0 && channels.get(channel) === set) channels.delete(channel);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      channels.clear();
      log.debug('memory pubsub closed');
    },
  };
}
