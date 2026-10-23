/**
 * `@arki/pubsub/memory`: in-process fan-out, for tests and one-process apps.
 * It has no `publishIn`: nothing here can join a database transaction.
 */
import { getLogger } from '@arki/log';

import type { PubSub } from './types.js';
import { checkChannel, checkMessage, checkOpen } from './limits.js';
import { createSubscribers, deliver } from './subscribers.js';

const log = getLogger('arki:pubsub');

/**
 * A pubsub inside this process. Each call makes its own, separate bus.
 * Messages arrive on a later microtask, never inside `publish`, in the order they were published.
 */
export function memoryPubSub(): PubSub {
  const subscribers = createSubscribers();
  let closed = false;

  return {
    async publish(channel, payload) {
      checkOpen(closed, 'memory');
      checkMessage(channel, payload);
      // Taken now: a subscriber that joins before the microtask runs did not see this publish.
      const receivers = subscribers.of(channel);
      queueMicrotask(() => deliver(receivers, payload));
    },
    async subscribe(channel, onMessage) {
      checkOpen(closed, 'memory');
      checkChannel(channel);
      const { subscription } = subscribers.add(channel, onMessage);
      return async () => {
        subscribers.remove(subscription);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      subscribers.clear();
      log.debug('memory pubsub closed');
    },
  };
}
