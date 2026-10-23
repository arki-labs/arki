/**
 * `fileStorage`: the files-table lifecycle on SQLite (libSQL).
 *
 *   createUpload ──► pending ──confirm──► ready ──remove──► deleting ──sweep──► (row gone)
 *
 * The lifecycle is shared (`../lifecycle/storage.ts`); this file holds its
 * SQLite statements. As on Postgres, every deadline comes from the database
 * clock. `instant` columns are integer milliseconds on SQLite, so deadlines
 * are millisecond arithmetic: `max()` for `greatest`, `+ ms` for intervals.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, eq, ne, sql } from 'drizzle-orm';

import type { FileStatements, StatementConfig } from '../lifecycle/statements.js';
import type { FileStorage, FileStorageOptions } from '../lifecycle/storage.js';
import type { FilesTable } from '../lifecycle/table.js';
import type { SignedUploadAdapter } from '../storage/types.js';
import { createFileStorage } from '../lifecycle/storage.js';
import { claimDue } from './cleanup.js';
import { sqliteNowMs as nowMs } from '@arki/db/sqlite';

/**
 * The root Drizzle database (`createLibsqlDb` from `@arki/db/libsql`). Pass the
 * root handle, never a transaction: storage I/O must not run inside one.
 */
export type FilesDb = LibSQLDatabase<AnyRelations>;

function sqliteStatements<T extends FilesTable<'sqlite'>>(
  db: FilesDb,
  table: T,
  config: StatementConfig,
): FileStatements<T> {
  const files: FilesTable<'sqlite'> = table;
  const graceMs = config.graceSeconds * 1000;

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
          expiresAt: sql`${nowMs} + ${ttl * 1000}`,
          cleanupAt: sql`${nowMs} + ${ttl * 1000 + graceMs}`,
        })
        .returning({ expiresAt: files.expiresAt });
      return row?.expiresAt;
    },

    async reject(id) {
      await db
        .update(files)
        .set({ status: 'deleting', cleanupAt: sql`max(${nowMs}, ${files.expiresAt} + ${graceMs})` })
        .where(and(eq(files.id, id), eq(files.status, 'pending')));
    },

    async markReady(id, { etag, sha256 }) {
      const [ready] = await db
        .update(files)
        .set({ status: 'ready', etag, sha256, confirmedAt: nowMs, cleanupAt: null })
        .where(and(eq(files.id, id), eq(files.status, 'pending'), sql`${files.cleanupAt} > ${nowMs}`))
        .returning();
      return ready;
    },

    async markDeleting(id) {
      // SET reads the old row; RETURNING reads the new one, so `due` sees the `cleanup_at` just written.
      const [marked] = await db
        .update(files)
        .set({
          status: 'deleting',
          cleanupAt: sql`case when ${files.status} = 'pending' then max(${nowMs}, ${files.expiresAt} + ${graceMs}) else ${nowMs} end`,
        })
        .where(and(eq(files.id, id), ne(files.status, 'deleting')))
        .returning({ key: files.key, due: sql`${files.cleanupAt} <= ${nowMs}`.mapWith(Boolean) });
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
 * const { db } = createLibsqlDb({ url: 'file:app.db', relations });
 * export const storage = fileStorage(db, createR2Storage({ ... }), {
 *   files, bucket: 'uploads', limits: { maxSize: 20_000_000, allowedMime: ['image/*', 'application/pdf'] },
 * });
 * ```
 */
export function fileStorage<T extends FilesTable<'sqlite'>>(
  db: FilesDb,
  adapter: SignedUploadAdapter,
  options: FileStorageOptions<T>,
): FileStorage<T> {
  return createFileStorage(adapter, options, config => sqliteStatements(db, options.files, config));
}
