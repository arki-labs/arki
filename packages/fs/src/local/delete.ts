/** Deletes files and folders by glob (the `del` package) and returns typed storage failures. */
import type { Options } from 'del';
import { deleteAsync as deletePaths } from 'del';
import { z } from 'zod';

import { StorageRejected } from '../storage/failures.js';
import { observeFs, storageWriteFailure } from '../storage/operation.js';

export type { Options } from 'del';

/** `del` refuses to delete the working directory or a path outside it with this error. */
const outsideWorkingDirectory = z.object({ name: z.literal('PresentableError') });

/**
 * Deletes the files and directories that match `patterns` (the `del` package). Returns the deleted paths, or
 * a failure: `StorageRejected` for a path outside the working directory (pass `force: true` or a `cwd`), a
 * permission error or a read-only file system; `StorageWriteUncertain` when some paths may already be gone.
 */
export function deleteAsync(patterns: string | readonly string[], options?: Options) {
  return observeFs('fs.local.delete_paths', async () => {
    try {
      return await deletePaths(patterns, options);
    } catch (error) {
      return outsideWorkingDirectory.safeParse(error).success
        ? StorageRejected({ cause: error })
        : storageWriteFailure(error);
    }
  });
}
