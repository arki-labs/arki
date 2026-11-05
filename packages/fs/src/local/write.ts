/** Appends to a local file and returns typed storage failures. */
import { appendFile } from 'node:fs/promises';

import { StorageRejected } from '../storage/failures.js';
import { observeFs, storageErrorFacts, storageWriteFailure } from '../storage/operation.js';

/**
 * Appends `data` to the end of a file, creating the file when it is missing. Returns nothing on success, or
 * a failure: `StorageRejected` when nothing was written (a missing directory, `EACCES`, a read-only file
 * system) and `StorageWriteUncertain` when the append may have partly happened (`ENOSPC`, an I/O fault).
 */
export function writeToTheFileEnd(pathToFile: string, data: string | Uint8Array) {
  return observeFs('fs.local.append', async () => {
    try {
      await appendFile(pathToFile, data);
      return;
    } catch (error) {
      // A missing parent directory is a definite refusal: no byte was written.
      return storageErrorFacts(error)?.code === 'ENOENT'
        ? StorageRejected({ cause: error })
        : storageWriteFailure(error);
    }
  });
}
