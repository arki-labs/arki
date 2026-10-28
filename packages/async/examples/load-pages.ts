import type { Clock } from '@arki/clock';
import type { FailureOf } from '@arki/failure';
import { SystemClock } from '@arki/clock';

import { mapConcurrent, resource, scoped, sleep } from '../src/index.js';

// #region load-pages
/** A connection that loads one page at a time and must be closed when the work ends. */
export type PageClient = {
  load(url: string, signal: AbortSignal): Promise<string | FailureOf<typeof sleep>>;
  close(): Promise<void>;
};

/**
 * Loads every page, four at a time, and requests cancellation after five seconds.
 * All started loads settle before the client closes, including on a deadline.
 */
export function loadPages(
  urls: readonly string[],
  openClient: () => Promise<PageClient>,
  options: { readonly clock?: Clock } = {},
) {
  const clock = options.clock ?? new SystemClock();
  return scoped(
    {
      deadline: resource(
        () => {
          const controller = new AbortController();
          const cancel = clock.setTimer(() => controller.abort(), 5000);
          return { signal: controller.signal, cancel };
        },
        deadline => deadline.cancel(),
      ),
    },
    ({ deadline }, signal) =>
      scoped(
        { client: resource(openClient, client => client.close()) },
        ({ client }, taskSignal) =>
          mapConcurrent(urls, (url, pageSignal) => client.load(url, pageSignal), {
            concurrency: 4,
            signal: taskSignal,
          }),
        { signal, deadline: deadline.signal },
      ),
  );
}
// #endregion
