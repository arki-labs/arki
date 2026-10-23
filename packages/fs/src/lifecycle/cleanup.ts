/**
 * The sweep: removes abandoned pending uploads and finishes removals.
 * Run it from a schedule (`defineSchedule` with a lock); the rows hold the
 * duty, so a missed tick loses nothing.
 */
import type { SignedUploadAdapter } from '../storage/types.js';
import type { FileStatements } from './statements.js';
import type { FilesTable } from './table.js';
import { FILE_ERROR_CODES } from '../files/errors.js';
import { fail, filesLog } from './context.js';

export type CleanupOptions = {
  /** Rows claimed per call, 1–1000. Default 100. */
  batch?: number;
};

export type CleanupResult = {
  removed: number;
  failed: number;
  /** True when the batch was full: call again (inside your time budget). */
  more: boolean;
};

/**
 * Claims due rows (`status <> 'ready'` and `cleanup_at <= now`), deletes each
 * object, then its row. The claim backs a row off before any delete (see
 * `FileStatements.claimDue`), so a failed delete is retried later.
 */
export async function cleanupOrphans<T extends FilesTable>(
  statements: FileStatements<T>,
  adapter: SignedUploadAdapter,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const batch = options.batch ?? 100;
  if (!Number.isInteger(batch) || batch < 1 || batch > 1000) {
    fail(FILE_ERROR_CODES.invalid, `cleanupOrphans: batch must be an integer from 1 to 1000, got ${String(batch)}`);
  }
  const started = Date.now();
  const claimed = await statements.claimDue(batch);

  let removed = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      await adapter.delete(row.key);
      await statements.deleteRow(row.id);
      removed += 1;
    } catch (error) {
      failed += 1;
      filesLog.warn('cleanup of {fileId} failed; retried after backoff', {
        fileId: row.id,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  filesLog.debug('cleanup: {removed} removed, {failed} failed in {ms} ms', {
    removed,
    failed,
    ms: Date.now() - started,
  });
  return { removed, failed, more: claimed.length === batch };
}
