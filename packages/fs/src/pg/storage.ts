/**
 * `fileStorage`: the files-table lifecycle on Postgres.
 *
 *   createUpload ──► pending ──confirm──► ready ──remove──► deleting ──sweep──► (row gone)
 *
 * The lifecycle is shared (`../lifecycle/storage.ts`); this file holds its
 * Postgres statements. Every deadline comes from the database clock (`now()`).
 */
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { and, eq, ne, sql } from 'drizzle-orm';

import type { FileStatements, StatementConfig } from '../lifecycle/statements.js';
import type { FileStorage, FileStorageOptions } from '../lifecycle/storage.js';
import type { FilesTable } from '../lifecycle/table.js';
import type { SignedUploadAdapter } from '../storage/types.js';
import { createFileStorage } from '../lifecycle/storage.js';
import { claimDue } from './cleanup.js';

/**
 * The root Drizzle database (`PgAsyncDatabase`, as in `@arki/journal`). Pass the
 * root handle, never a transaction: storage I/O must not run inside one.
 */
export type FilesDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

function pgStatements<T extends FilesTable<'pg'>>(db: FilesDb, table: T, config: StatementConfig): FileStatements<T> {
  const files: FilesTable<'pg'> = table;
  const grace = sql`make_interval(secs => ${config.graceSeconds})`;

  return {
    async read(id) {
      const [row] = await db
        .select()
        .from(files)
        .where(and(eq(files.id, id), eq(files.bucket, config.bucket)))
        .limit(1);
      return row;
    },

    async insertPending(file, ttl) {
      const [row] = await db
        .insert(files)
        .values({
          ...file,
          bucket: config.bucket,
          status: 'pending',
          expiresAt: sql`now() + make_interval(secs => ${ttl})`,
          cleanupAt: sql`now() + make_interval(secs => ${ttl + config.graceSeconds})`,
        })
        .returning({ expiresAt: files.expiresAt });
      return row?.expiresAt;
    },

    async reject(id) {
      await db
        .update(files)
        .set({ status: 'deleting', cleanupAt: sql`greatest(now(), ${files.expiresAt} + ${grace})` })
        .where(and(eq(files.id, id), eq(files.status, 'pending')));
    },

    async markReady(id, { etag, sha256 }) {
      const [ready] = await db
        .update(files)
        .set({ status: 'ready', etag, sha256, confirmedAt: sql`now()`, cleanupAt: null })
        .where(and(eq(files.id, id), eq(files.status, 'pending'), sql`${files.cleanupAt} > now()`))
        .returning();
      return ready;
    },

    async markDeleting(id) {
      const [marked] = await db
        .update(files)
        .set({
          status: 'deleting',
          cleanupAt: sql`case when ${files.status} = 'pending' then greatest(now(), ${files.expiresAt} + ${grace}) else now() end`,
        })
        .where(and(eq(files.id, id), ne(files.status, 'deleting')))
        .returning({ key: files.key, due: sql<boolean>`${files.cleanupAt} <= now()` });
      return marked;
    },

    async deleteRow(id) {
      await db.delete(files).where(and(eq(files.id, id), eq(files.status, 'deleting')));
    },

    claimDue: batch => claimDue(db, files, config.bucket, batch),
  };
}

/**
 * Builds the files lifecycle once, at boot. Synchronous and cheap: it only
 * validates `options` (`ARKI_FS_E001`) and the adapter (`ARKI_FS_E006`).
 *
 * @example
 * ```ts
 * export const storage = fileStorage(db, createR2Storage({ ... }), {
 *   files, bucket: 'uploads', limits: { maxSize: 20_000_000, allowedMime: ['image/*', 'application/pdf'] },
 * });
 * ```
 */
export function fileStorage<T extends FilesTable<'pg'>>(
  db: FilesDb,
  adapter: SignedUploadAdapter,
  options: FileStorageOptions<T>,
): FileStorage<T> {
  return createFileStorage(adapter, options, config => pgStatements(db, options.files, config));
}
