import type { Clock } from '@arki/clock';

import { mapConcurrent, scoped, timeout } from '../src/index.js';

// #region load-pages
/** A connection that loads one page at a time and must be closed when the work ends. */
export type PageClient = {
  load(url: string, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
};

/**
 * Loads every page, four at a time, and gives up after five seconds.
 * The client is closed on success, on failure and on timeout.
 */
export function loadPages(
  urls: readonly string[],
  openClient: () => Promise<PageClient>,
  options: { readonly clock?: Clock } = {},
): Promise<string[]> {
  return scoped(async scope => {
    const client = await scope.acquire(openClient, opened => opened.close());
    return timeout(
      signal => mapConcurrent(urls, (url, taskSignal) => client.load(url, taskSignal), { concurrency: 4, signal }),
      5000,
      { signal: scope.signal, ...options },
    );
  });
}
// #endregion
