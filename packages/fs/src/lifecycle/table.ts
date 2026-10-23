/**
 * The files table, written once for Postgres and SQLite. Call it once in the
 * app's schema module so `drizzle-kit generate` creates the table. The library
 * never runs DDL.
 */
import { sql } from 'drizzle-orm';

import type { ColumnKit, Dialect } from '@arki/db/columns';
import type { IdColumnSource } from '@arki/db/id';

import { FILE_STATUSES, fileId } from '../files/schemas.js';

export type FilesTableOptions<TOwner extends string> = {
  /** The owner id kind, e.g. the app's `defineId('usr_')`. Its type becomes `ownerId`'s type. */
  owner: IdColumnSource<TOwner>;
  /** Table name. Default `'files'`. Also prefixes the constraint and index names. */
  name?: string;
};

/**
 * The files table: one row per stored object, written before any byte is.
 * No foreign key on `owner_id`: deleting an owner must not drop the row that
 * carries the cleanup duty. The kit picks the dialect and where the table
 * lives: `pgColumns(schema?)` or `sqliteColumns({ prefix? })`.
 *
 * @example
 * ```ts
 * export const files = filesTable(pgColumns(), { owner: userId });
 * ```
 */
export function filesTable<D extends Dialect, TOwner extends string>(
  c: ColumnKit<D>,
  options: FilesTableOptions<TOwner>,
) {
  const name = options.name ?? 'files';

  return c.table(
    name,
    {
      /** `fil_` + 24 random characters. */
      id: c.id(fileId).primaryColumn(),
      ownerId: c.id(options.owner).reference('owner_id'),
      /** The binding name from `fileStorage(..., { bucket })`, e.g. `'uploads'`. */
      bucket: c.text('bucket').notNull(),
      /** `${keyPrefix}/${id}`. Derived by the server, never sent by a client. */
      key: c.text('key').notNull(),
      mime: c.text('mime').notNull(),
      size: c.bigint('size').notNull(),
      /** Lowercase hex. Only set with `verify: 'hash'`. */
      sha256: c.char('sha256', { length: 64 }),
      etag: c.text('etag'),
      status: c.text('status', { enum: FILE_STATUSES }).notNull().default('pending'),
      /** When the PUT URL dies (database time). */
      expiresAt: c.instant('expires_at', { precision: 3 }).notNull(),
      /** When the sweep may act. Null on ready rows. */
      cleanupAt: c.instant('cleanup_at', { precision: 3 }),
      cleanupAttempts: c.integer('cleanup_attempts').notNull().default(0),
      createdAt: c.instant('created_at', { precision: 3 }).notNull().defaultNow(),
      confirmedAt: c.instant('confirmed_at', { precision: 3 }),
    },
    t => [
      c.unique(`${name}_bucket_key_unique`).on(t.bucket, t.key),
      c.check(`${name}_size_check`, sql`${t.size} between 0 and 9007199254740991`),
      // Postgres has `~`; libSQL ships SQLite's `regexp` function, which backs the `REGEXP` operator.
      c.check(
        `${name}_sha256_check`,
        c.dialect === 'pg' ? sql`${t.sha256} ~ '^[0-9a-f]{64}$'` : sql`${t.sha256} regexp '^[0-9a-f]{64}$'`,
      ),
      c.check(`${name}_status_check`, sql`${t.status} in ('pending', 'ready', 'deleting')`),
      c.check(`${name}_cleanup_attempts_check`, sql`${t.cleanupAttempts} >= 0`),
      c.check(
        `${name}_ready_check`,
        sql`${t.status} <> 'ready' or (${t.confirmedAt} is not null and ${t.cleanupAt} is null)`,
      ),
      c.check(`${name}_cleanup_check`, sql`${t.status} = 'ready' or ${t.cleanupAt} is not null`),
      /** Keyset pages per owner. */
      c.index(`${name}_owner_idx`).on(t.ownerId, c.desc(t.createdAt), c.desc(t.id)),
      /** The one sweep predicate. */
      c
        .index(`${name}_sweep_idx`)
        .on(t.cleanupAt, t.id)
        .where(sql`${t.status} <> 'ready'`),
    ],
  );
}

/**
 * The files table of dialect `D` with owner ids `TOwner`. The defaults give any
 * files table: use it as the bound of generic code, `T extends FilesTable`.
 * Distributed over `D`, so the default is one table per dialect, never one
 * table of a mixed dialect.
 */
export type FilesTable<D extends Dialect = Dialect, TOwner extends string = string> = D extends Dialect
  ? ReturnType<typeof filesTable<D, TOwner>>
  : never;
/** A row of the files table `T`. */
export type FileRow<T extends FilesTable> = T['$inferSelect'];
/** The owner id type of the files table `T`, e.g. `` `usr_${string}` ``. */
export type OwnerOf<T extends FilesTable> = FileRow<T>['ownerId'];
