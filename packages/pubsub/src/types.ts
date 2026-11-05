/**
 * The contract every backend implements. Delivery is best effort, like Postgres
 * NOTIFY: a subscriber gets the messages published after its `subscribe`
 * resolved, nothing is replayed, and order is kept per channel per publisher.
 */

/** Called once per message on the channel it was given to. */
export type OnMessage = (payload: string) => void;

/**
 * Stops one subscription. Calling it again does nothing. Its shape fits
 * `@arki/journal`'s `WakeListener`, so `listen: fn => pubsub.subscribe(channel, fn)` needs no adapter
 * (a subscribe failure fits it too: the worker's `start()` returns it).
 */
export type Unsubscribe = () => Promise<void>;

/**
 * Publish and subscribe on named channels. `SubscribeFailure` is what `subscribe` returns when the
 * backend cannot listen: `db.listen_unavailable` for pg, none (`never`) for the others.
 */
export type PubSub<SubscribeFailure = never> = {
  /** Sends `payload` to the channel's subscribers now. Resolves once the backend accepted it. */
  publish(channel: string, payload: string): Promise<void>;
  /**
   * Resolves once the subscription is live: every later publish on `channel` reaches `onMessage`.
   * Resolves to `SubscribeFailure` instead when the backend cannot listen; nothing is subscribed then.
   */
  subscribe(channel: string, onMessage: OnMessage): Promise<Unsubscribe | SubscribeFailure>;
  /** Stops every subscription and frees the backend's connections. Later calls throw a `closed` error. */
  close(): Promise<void>;
};

/** A {@link PubSub} that can also publish inside the writer's own database transaction. */
export type TransactionalPubSub<Tx, SubscribeFailure = never> = PubSub<SubscribeFailure> & {
  /** Sent when `tx` commits; dropped if it rolls back. */
  publishIn(tx: Tx, channel: string, payload: string): Promise<void>;
};
