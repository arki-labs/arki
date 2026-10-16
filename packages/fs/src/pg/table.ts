/**
 * The files table, as a factory. Call it once in the app's schema module so
 * `drizzle-kit generate` creates the table. The library never runs DDL.
 */
import type { PgSchema, PgTableFn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigint, char, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';

import type { IdColumnSource } from '@arki/db/id';
import { idColumns } from '@arki/db/id';
import { instant } from '@arki/db/temporal';

import { FILE_STATUSES, fileId } from '../files/schemas.js';

export type FilesTableOptions<TOwner extends string> = {
  /** The owner id kind, e.g. the app's `defineId('usr_')`. Its type becomes `ownerId`'s type. */
  owner: IdColumnSource<TOwner>;
  /** Table name. Default `'files'`. Also prefixes the constraint and index names. */
  name?: string;
  /** A Postgres schema, as in `journalTables(schema?)`. Default: the public schema. */
  schema?: PgSchema;
};

/**
 * The files table: one row per stored object, written before any byte is.
 * No foreign key on `owner_id`: deleting an owner must not drop the row that
 * carries the cleanup duty.
 *
 * @example
 * ```ts
 * export const files = filesTable({ owner: userId });
 * ```
 */
export function filesTable<TOwner extends string>(options: FilesTableOptions<TOwner>) {
  const name = options.name ?? 'files';
  const table: PgTableFn<string | undefined> = options.schema === undefined ? pgTable : options.schema.table;

  return table(
    name,
    {
      /** `fil_` + 24 random characters. */
      id: idColumns(fileId).primaryColumn(),
      ownerId: idColumns(options.owner).reference('owner_id'),
      /** The binding name from `fileStorage(..., { bucket })`, e.g. `'uploads'`. */
      bucket: text('bucket').notNull(),
      /** `${keyPrefix}/${id}`. Derived by the server, never sent by a client. */
      key: text('key').notNull(),
      mime: text('mime').notNull(),
      size: bigint('size', { mode: 'number' }).notNull(),
      /** Lowercase hex. Only set with `verify: 'hash'`. */
      sha256: char('sha256', { length: 64 }),
      etag: text('etag'),
      status: text('status', { enum: FILE_STATUSES }).notNull().default('pending'),
      /** When the PUT URL dies (database time). */
      expiresAt: instant('expires_at', { precision: 3 }).notNull(),
      /** When the sweep may act. Null on ready rows. */
      cleanupAt: instant('cleanup_at', { precision: 3 }),
      cleanupAttempts: integer('cleanup_attempts').notNull().default(0),
      createdAt: instant('created_at', { precision: 3 })
        .notNull()
        .default(sql`now()`),
      confirmedAt: instant('confirmed_at', { precision: 3 }),
    },
    t => [
      unique(`${name}_bucket_key_unique`).on(t.bucket, t.key),
      check(`${name}_size_check`, sql`${t.size} between 0 and 9007199254740991`),
      check(`${name}_sha256_check`, sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
      check(`${name}_status_check`, sql`${t.status} in ('pending', 'ready', 'deleting')`),
      check(`${name}_cleanup_attempts_check`, sql`${t.cleanupAttempts} >= 0`),
      check(
        `${name}_ready_check`,
        sql`${t.status} <> 'ready' or (${t.confirmedAt} is not null and ${t.cleanupAt} is null)`,
      ),
      check(`${name}_cleanup_check`, sql`${t.status} = 'ready' or ${t.cleanupAt} is not null`),
      /** Keyset pages per owner. */
      index(`${name}_owner_idx`).on(t.ownerId, t.createdAt.desc(), t.id.desc()),
      /** The one sweep predicate. */
      index(`${name}_sweep_idx`)
        .on(t.cleanupAt, t.id)
        .where(sql`${t.status} <> 'ready'`),
    ],
  );
}

/** Any files table. Use it as the bound of generic code: `T extends FilesTable`. */
export type FilesTable = ReturnType<typeof filesTable<string>>;
/** A row of the files table `T`. */
export type FileRow<T extends FilesTable> = T['$inferSelect'];
/** The owner id type of the files table `T`, e.g. `` `usr_${string}` ``. */
export type OwnerOf<T extends FilesTable> = FileRow<T>['ownerId'];
