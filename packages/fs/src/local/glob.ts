/** Finds files by glob (the `glob` package) and returns typed storage failures. */
import type { GlobOptionsWithFileTypesFalse } from 'glob';
import { glob as globPaths } from 'glob';

import { observeFs, storageReadFailure } from '../storage/operation.js';

export type { GlobOptionsWithFileTypesFalse } from 'glob';

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
