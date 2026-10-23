/**
 * The sweep's claim on SQLite (libSQL). The loop around it is shared
 * (`../lifecycle/cleanup.ts`).
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { FilesTable } from '../lifecycle/table.js';
import type { FilesDb } from './storage.js';
import { nowMs } from './clock.js';

/**
 * Claims due rows with one `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING`
 * inside a write transaction. SQLite has one writer and no `SKIP LOCKED`:
 * libSQL opens the transaction with `BEGIN IMMEDIATE`, which takes the only
 * write lock, so sweepers in different processes take turns instead of running
 * side by side. Each still claims rows no other sweeper holds, because a claim
 * moves `cleanup_at` past now before the lock is released.
 *
 * The claim pushes `cleanup_at` out with backoff (1 min, doubling, at most
 * 1 day), in milliseconds: `instant` columns are integer milliseconds here.
 */
export async function claimDue(db: FilesDb, files: FilesTable<'sqlite'>, bucket: string, batch: number) {
  return db.transaction(async tx => {
    const due = tx
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.bucket, bucket), ne(files.status, 'ready'), sql`${files.cleanupAt} <= ${nowMs}`))
      .orderBy(files.cleanupAt, files.id)
      .limit(batch);

    return tx
      .update(files)
      .set({
        status: 'deleting',
        cleanupAttempts: sql`${files.cleanupAttempts} + 1`,
        // 2^11 minutes is past a day, so the exponent stops there. `power()` gives a real; the cast keeps integer ms.
        cleanupAt: sql`${nowMs} + cast(min(60000 * power(2, min(${files.cleanupAttempts}, 11)), 86400000) as integer)`,
      })
      .where(inArray(files.id, due))
      .returning({ id: files.id, key: files.key });
  });
}
