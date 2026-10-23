/**
 * The sweep's claim on Postgres. The loop around it is shared
 * (`../lifecycle/cleanup.ts`).
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { FilesTable } from '../lifecycle/table.js';
import type { FilesDb } from './storage.js';

/**
 * Claims due rows with `FOR UPDATE SKIP LOCKED`, so sweepers in several
 * processes run side by side and never take the same row. The claim pushes
 * `cleanup_at` out with backoff (1 min, doubling, at most 1 day) before any
 * delete.
 */
export async function claimDue(db: FilesDb, files: FilesTable<'pg'>, bucket: string, batch: number) {
  const due = db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.bucket, bucket), ne(files.status, 'ready'), sql`${files.cleanupAt} <= now()`))
    .orderBy(files.cleanupAt, files.id)
    .limit(batch)
    .for('update', { skipLocked: true });

  return db
    .update(files)
    .set({
      status: 'deleting',
      cleanupAttempts: sql`${files.cleanupAttempts} + 1`,
      // 2^11 minutes is past a day, so the exponent is capped there and never overflows an interval.
      cleanupAt: sql`now() + least(interval '1 minute' * power(2, least(${files.cleanupAttempts}, 11)), interval '1 day')`,
    })
    .where(inArray(files.id, due))
    .returning({ id: files.id, key: files.key });
}
