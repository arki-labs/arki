/**
 * The local fan-out every backend shares: which callbacks listen on which
 * channel. A backend hears a channel once and hands each message to the
 * subscriptions this registry holds.
 */
import { getLogger } from '@arki/log';

import type { OnMessage } from './types.js';

const log = getLogger('arki:pubsub');

/** One `subscribe` call. `active` turns false when it is removed, so a message already on its way is dropped. */
export type Subscription = { readonly channel: string; readonly onMessage: OnMessage; active: boolean };

/** Hand `payload` to each still-active subscription. A callback that throws is logged and never stops the others. */
export function deliver(subscriptions: readonly Subscription[], payload: string): void {
  for (const subscription of subscriptions) {
    if (!subscription.active) continue;
    try {
      subscription.onMessage(payload);
    } catch (error) {
      log.warn('a subscriber on {channel} threw: {message}', {
        channel: subscription.channel,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** A registry of subscriptions by channel. */
export function createSubscribers() {
  const byChannel = new Map<string, Set<Subscription>>();

  return {
    /** Adds a subscription; `first` is true when no one listened on `channel` before. */
    add(channel: string, onMessage: OnMessage): { readonly subscription: Subscription; readonly first: boolean } {
      const subscription: Subscription = { channel, onMessage, active: true };
      const existing = byChannel.get(channel);
      if (existing) {
        existing.add(subscription);
        return { subscription, first: false };
      }
      byChannel.set(channel, new Set([subscription]));
      return { subscription, first: true };
    },
    /** Removes a subscription. True when it was the last one on its channel; false when it was already gone. */
    remove(subscription: Subscription): boolean {
      if (!subscription.active) return false;
      subscription.active = false;
      const set = byChannel.get(subscription.channel);
      if (!set) return false;
      set.delete(subscription);
      if (set.size > 0) return false;
      byChannel.delete(subscription.channel);
      return true;
    },
    /** The channel's subscriptions now, copied: one that subscribes later does not get this message. */
    of(channel: string): readonly Subscription[] {
      return [...(byChannel.get(channel) ?? [])];
    },
    /** The channels someone listens on. */
    channels(): string[] {
      return [...byChannel.keys()];
    },
    /** Deactivates and forgets every subscription. */
    clear(): void {
      for (const set of byChannel.values()) for (const subscription of set) subscription.active = false;
      byChannel.clear();
    },
  };
}

/** The registry {@link createSubscribers} returns. */
export type Subscribers = ReturnType<typeof createSubscribers>;
