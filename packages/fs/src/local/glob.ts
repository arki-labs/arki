/** Finds files by glob (the `glob` package) and returns typed storage failures. */
import type { GlobOptionsWithFileTypesFalse } from 'glob';
import { glob as globPaths, globIterate as iteratePaths } from 'glob';

import { observeFs, storageReadFailure } from '../storage/operation.js';

export type { GlobOptionsWithFileTypesFalse } from 'glob';

/** What `glob`, `globIterate` and `globStream` return instead of throwing. */
type GlobFailure = ReturnType<typeof storageReadFailure>;

/**
 * Lists the paths that match `pattern` (the `glob` package). Unreadable directories are skipped and a missing
 * directory gives no matches. Returns the paths, or a failure: `StorageCancelled` when `options.signal`
 * aborts, and `UnexpectedDefect` for an invalid option set (for example `matchBase` with `noglobstar`).
 */
export function glob(pattern: string | string[], options: GlobOptionsWithFileTypesFalse = {}) {
  return observeFs('fs.local.glob', async () => {
    try {
      return await globPaths(pattern, options);
    } catch (error) {
      return storageReadFailure(error, options.signal);
    }
  });
}

/**
 * Yields the matching paths one at a time. It never throws: the generator's return value is `undefined`
 * when the walk finished, or the same failure `glob` returns. The span covers the whole walk and ends
 * early when the caller stops iterating.
 *
 * @example
 * ```ts
 * const paths = globIterate('**\/*.md', { cwd: 'docs' });
 * let next = await paths.next();
 * for (; !next.done; next = await paths.next()) console.info(next.value);
 * if (isFailure(next.value)) return next.value;
 * ```
 */
export async function* globIterate(
  pattern: string | string[],
  options: GlobOptionsWithFileTypesFalse = {},
): AsyncGenerator<string, GlobFailure | undefined, undefined> {
  const walk = Promise.withResolvers<GlobFailure | undefined>();
  const observed = observeFs('fs.local.glob', () => walk.promise);
  let failure: GlobFailure | undefined;
  try {
    for await (const path of iteratePaths(pattern, options)) yield path;
  } catch (error) {
    failure = storageReadFailure(error, options.signal);
  } finally {
    // Also runs when the caller stops early, so the span always ends.
    walk.resolve(failure);
  }
  return await observed;
}

/**
 * The matching paths as a web `ReadableStream`. It never errors: a failure arrives as the last chunk, the
 * same failure `glob` returns, and then the stream closes. Cancelling the stream stops the walk.
 */
export function globStream(pattern: string | string[], options: GlobOptionsWithFileTypesFalse = {}) {
  const paths = globIterate(pattern, options);
  return new ReadableStream<string | GlobFailure>({
    async pull(controller) {
      const next = await paths.next();
      if (!next.done) {
        controller.enqueue(next.value);
        return;
      }
      if (next.value !== undefined) controller.enqueue(next.value);
      controller.close();
    },
    async cancel() {
      // eslint-disable-next-line failure/must-use, unicorn/no-useless-undefined -- cancel only stops the walk; a cancelled stream has no reader left for an outcome.
      await paths.return(undefined);
    },
  });
}
