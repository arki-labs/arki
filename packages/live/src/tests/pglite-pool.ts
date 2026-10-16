/**
 * A listen "pool" on one PGlite instance for the Dot plugin tests: PGlite has
 * one connection, so the listener's client is that same instance
 * (notifications to the listening session itself are delivered at commit).
 * Test-only.
 */
import type { PGlite } from '@electric-sql/pglite';

import type { liveQueries } from '../dot.js';

/** `@arki/db/pg`'s pool and client types, as `liveQueries` takes them (only adapter entries import that peer). */
type ListenPool = ReturnType<Parameters<typeof liveQueries>[0]['pool']>;
type ListenClient = Awaited<ReturnType<ListenPool['connect']>>;

type Notification = { readonly channel: string; readonly payload?: string };
type Handlers = {
  notification: (message: Notification) => void;
  error: (error: Error) => void;
  end: () => void;
};

/** A listen "pool" on one PGlite instance, counting what the listener takes and gives back. */
export function pglitePool(
  pglite: PGlite,
): ListenPool & { readonly stats: { connects: number; releases: number; queries: string[] } } {
  const stats = { connects: 0, releases: 0, queries: [] as string[] };
  return {
    stats,
    connect() {
      stats.connects += 1;
      const handlers: { [Event in keyof Handlers]: Handlers[Event][] } = { notification: [], error: [], end: [] };
      const unsubscribe = pglite.onNotification((channel, payload) => {
        for (const listener of handlers.notification) listener({ channel, payload });
      });
      const client: ListenClient = {
        async query(text) {
          stats.queries.push(text);
          return await pglite.query(text);
        },
        on<Event extends keyof Handlers>(event: Event, listener: Handlers[Event]) {
          handlers[event].push(listener);
        },
        release() {
          stats.releases += 1;
          unsubscribe();
        },
      };
      return Promise.resolve(client);
    },
  };
}
