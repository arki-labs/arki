/** Reads and decodes a whole local file and returns typed storage failures. */
import { readFile as readFileBytes } from 'node:fs/promises';
import iconv from 'iconv-lite';

import { getLogger } from '@arki/log';

import { StorageCancelled, StorageNotFound, StorageRejected } from '../storage/failures.js';
import { observeFs, storageErrorFacts, storageReadFailure } from '../storage/operation.js';

const log = getLogger('arki:fs');

/**
 * Reads a whole file and decodes it with `encoding` (`utf8`, `latin1`, `win1252`, any iconv-lite name).
 * Returns the text, or a failure: `StorageNotFound` for a missing path, `StorageRejected` for an unknown
 * encoding or a refused read (`EACCES`, a directory), `StorageUnavailable` for an I/O fault and
 * `StorageCancelled` when `signal` aborts.
 */
export const readFile = (pathToFile: string, encoding: string, options: { signal?: AbortSignal } = {}) =>
  observeFs('fs.local.read_file', async () => {
    if (options.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
    if (!iconv.encodingExists(encoding)) {
      log.debug('unknown encoding {encoding}', { encoding });
      return StorageRejected();
    }
    log.debug('reading file {encoding}', { encoding });
    try {
      const buffer = await readFileBytes(pathToFile, { signal: options.signal });
      return encoding === 'utf8' ? buffer.toString() : iconv.decode(buffer, encoding);
    } catch (error) {
      return storageErrorFacts(error)?.code === 'ENOENT'
        ? StorageNotFound({ cause: error })
        : storageReadFailure(error, options.signal);
    }
  });
