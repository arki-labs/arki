/**
 * Test helpers. Portable at runtime; `waitForInvalidation`
 * takes a TanStack `QueryClient` (a type-only import of the optional peer).
 */
import type { QueryClient } from '@tanstack/react-query';

import type { LiveSource, LiveSourceEvent } from './hub.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';

/** A source the test drives: `emit` delivers to the hub that started it. */
export function fakeSource(): LiveSource & { emit(event: LiveSourceEvent): void } {
  let receive: ((event: LiveSourceEvent) => void) | undefined;
  return {
    start(next) {
      receive = next;
      const stop = (): Promise<void> => {
        receive = undefined;
        return Promise.resolve();
      };
      return Promise.resolve(stop);
    },
    emit(event) {
      if (!receive) {
        throw liveError(
          LIVE_ERROR_CODES.source,
          'fakeSource().emit() before a hub started it (or after it stopped)',
          'Call hub.start() first.',
        );
      }
      receive(event);
    },
  };
}

/**
 * Resolves when a query of oRPC path `path` (its full key path, `keyPrefix`
 * included) is invalidated; rejects with E006 after `timeoutMs`. Subscribe
 * before the write that should cause it.
 */
export function waitForInvalidation(
  queryClient: QueryClient,
  path: readonly string[],
  timeoutMs = 5000,
): Promise<void> {
  const pathKey = JSON.stringify(path);
  return new Promise((resolve, reject) => {
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type !== 'updated' || event.action.type !== 'invalidate') return;
      if (JSON.stringify(event.query.queryKey[0]) !== pathKey) return;
      done();
      resolve();
    });
    const timer = setTimeout(() => {
      done();
      reject(
        liveError(
          LIVE_ERROR_CODES.limit,
          `waitForInvalidation(): no query of ${pathKey} was invalidated within ${timeoutMs} ms`,
          'Check the procedure has live() meta reading the table you wrote, and that the LiveProvider is connected.',
        ),
      );
    }, timeoutMs);
    function done(): void {
      clearTimeout(timer);
      unsubscribe();
    }
  });
}
