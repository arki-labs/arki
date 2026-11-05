/** Deletes files and folders by glob (the `del` package) and returns typed storage failures. */
import type { ProgressData as DelProgressData, Options } from 'del';
import { deleteAsync as deletePaths, deleteSync as deletePathsSync } from 'del';
import { z } from 'zod';

import { StorageRejected } from '../storage/failures.js';
import { observeFs, observeFsSync, storageWriteFailure } from '../storage/operation.js';

export type { Options } from 'del';

/**
 * The progress `del` reports to `options.onProgress` after each deleted path.
 *
 * @example
 * ```ts
 * import type { ProgressData } from '@arki/fs/local/delete';
 * import { deleteAsync } from '@arki/fs/local/delete';
 *
 * const onProgress = (progress: ProgressData) => progress.percent; // 0 to 1
 * const deleted = await deleteAsync('tmp/*.log', { onProgress });
 * ```
 */
export type ProgressData = DelProgressData;

/** `del` refuses to delete the working directory or a path outside it with this error. */
const outsideWorkingDirectory = z.object({ name: z.literal('PresentableError') });

function deleteFailure(error: unknown) {
  return outsideWorkingDirectory.safeParse(error).success
    ? StorageRejected({ cause: error })
    : storageWriteFailure(error);
}

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
      return deleteFailure(error);
    }
  });
}

/** The synchronous form of {@link deleteAsync}: the same paths, failures, span and metric. */
export function deleteSync(patterns: string | readonly string[], options?: Options) {
  return observeFsSync('fs.local.delete_paths', () => {
    try {
      return deletePathsSync(patterns, options);
    } catch (error) {
      return deleteFailure(error);
    }
  });
}
