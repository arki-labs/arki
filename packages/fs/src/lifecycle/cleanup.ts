/** Durable rows retain cleanup duty until both object and row deletion are confirmed. */
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import type { SignedUploadAdapter } from '../storage/types.js';
import type { FileStatements } from './statements.js';
import type { FilesTable } from './table.js';
import { executeFs, storageWriteFailure } from '../storage/operation.js';
import { writeStatement } from './database.js';

export const cleanupOptions = z.strictObject({ batch: z.number().int().min(1).max(1000).default(100) });
export type CleanupOptions = { batch?: number };
export type CleanupResult = { removed: number; failed: number; more: boolean };

export function cleanupOrphans<T extends FilesTable>(
  statements: FileStatements<T>,
  adapter: SignedUploadAdapter,
  options: CleanupOptions = {},
) {
  return executeFs('fs.files.cleanup', async () => {
    const parsed = parse(cleanupOptions, options);
    if (isFailure(parsed)) return parsed;
    const { batch } = parsed;
    const claimed = await writeStatement(() => statements.claimDue(batch));
    if (isFailure(claimed)) return claimed;
    let removed = 0;
    for (const row of claimed) {
      // A returned refusal is final. The backoff claim already preserved the durable retry duty.
      let deleted;
      try {
        deleted = await adapter.delete(row.key);
      } catch (error) {
        return storageWriteFailure(error);
      }
      if (isFailure(deleted)) return deleted;
      const outcome = await writeStatement(() => statements.deleteRow(row.id));
      if (isFailure(outcome)) return outcome;
      removed++;
    }
    return { removed, failed: 0, more: claimed.length === batch } satisfies CleanupResult;
  });
}
