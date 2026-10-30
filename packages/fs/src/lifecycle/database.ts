/** Owned SQL calls stay separate from storage I/O; nothing here retries a write. */
import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { findDatabaseError } from '@arki/db/errors';
import { UnexpectedFailure } from '@arki/failure';

import { StorageRejected, StorageUnavailable } from '../storage/failures.js';
import { storageErrorFacts, storageReadFailure, storageWriteFailure } from '../storage/operation.js';

export async function readStatement<T>(run: () => PromiseLike<T>) {
  try {
    return await run();
  } catch (error) {
    const facts = findDatabaseError(error);
    if (storageErrorFacts(error)?.code?.startsWith('SQLITE_CONSTRAINT')) return StorageRejected({ cause: error });
    if (facts)
      return facts.sqlState.startsWith('08') || ['57P01', '57P02', '57P03'].includes(facts.sqlState)
        ? StorageUnavailable({ cause: error })
        : StorageRejected({ cause: error });
    return storageReadFailure(error);
  }
}

export async function writeStatement<T>(run: () => PromiseLike<T>) {
  try {
    return await run();
  } catch (error) {
    // A Drizzle scalar default cannot return a Failure. Restore only its declared canonical definitions.
    if (error instanceof UnexpectedFailure) {
      for (const definition of ID_GENERATION_FAILURES) if (definition.is(error.failure)) return error.failure;
    }
    const facts = findDatabaseError(error);
    if (facts && !facts.sqlState.startsWith('08') && !['57P01', '57P02', '57P03'].includes(facts.sqlState))
      return StorageRejected({ cause: error });
    if (storageErrorFacts(error)?.code?.startsWith('SQLITE_CONSTRAINT')) return StorageRejected({ cause: error });
    return storageWriteFailure(error);
  }
}
