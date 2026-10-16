/**
 * The sweep: removes abandoned pending uploads and finishes removals.
 * Run it from a schedule (`defineSchedule` with a lock); the rows hold the
 * duty, so a missed tick loses nothing.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { FilesContext } from './context.js';
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
 * Claims due rows (`status <> 'ready'` and `cleanup_at <= now()`), deletes each
 * object, then its row. A claim pushes `cleanup_at` out with backoff (1 min,
 * doubling, at most 1 day) before any delete, so a failing object cannot
 * starve later rows and two sweepers never take the same row.
 */
export async function cleanupOrphans(context: FilesContext, options: CleanupOptions = {}): Promise<CleanupResult> {
  const { db, adapter, files, bucket } = context;
  const batch = options.batch ?? 100;
  if (!Number.isInteger(batch) || batch < 1 || batch > 1000) {
    fail(FILE_ERROR_CODES.invalid, `cleanupOrphans: batch must be an integer from 1 to 1000, got ${String(batch)}`);
  }
  const started = Date.now();

  const due = db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.bucket, bucket), ne(files.status, 'ready'), sql`${files.cleanupAt} <= now()`))
    .orderBy(files.cleanupAt, files.id)
    .limit(batch)
    .for('update', { skipLocked: true });

  const claimed = await db
    .update(files)
    .set({
      status: 'deleting',
      cleanupAttempts: sql`${files.cleanupAttempts} + 1`,
      // 2^11 minutes is past a day, so the exponent is capped there and never overflows an interval.
      cleanupAt: sql`now() + least(interval '1 minute' * power(2, least(${files.cleanupAttempts}, 11)), interval '1 day')`,
    })
    .where(inArray(files.id, due))
    .returning({ id: files.id, key: files.key });

  let removed = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      await adapter.delete(row.key);
      await db.delete(files).where(and(eq(files.id, row.id), eq(files.status, 'deleting')));
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
