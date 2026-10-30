import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { StorageCancelled, StorageNotFound } from '../storage/failures.js';
import { observeFs, storageErrorFacts, storageReadFailure } from '../storage/operation.js';

/** The first line, or undefined for an empty file. Every terminal path closes the stream. */
export function readFirstLine(pathToFile: string, options: { signal?: AbortSignal } = {}) {
  return observeFs('fs.local.read_first_line', async () => {
    if (options.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
    const readable = createReadStream(pathToFile, { signal: options.signal });
    const reader = createInterface({ input: readable });
    try {
      for await (const line of reader) return line;
      return;
    } catch (error) {
      return storageErrorFacts(error)?.code === 'ENOENT'
        ? StorageNotFound({ cause: error })
        : storageReadFailure(error, options.signal);
    } finally {
      reader.close();
      readable.destroy();
    }
  });
}
