import type { ColumnKit, Dialect } from '@arki/db/columns';

import type { IdempotencyKeyId } from './idempotency-id.js';
export type { IdempotencyKeyId } from './idempotency-id.js';

const TABLE_NAME = 'offline_idempotency_keys';
const UNIQUE_INDEX_NAME = 'offline_idk_key_path_user_idx';

/**
 * The idempotency table, written once for every dialect. Pass
 * `pgColumns(schema)` from `@arki/db/pg` or `sqliteColumns()` from
 * `@arki/db/sqlite`. This file imports no dialect runtime.
 */
export function createIdempotencyTable<D extends Dialect>(c: ColumnKit<D>) {
  return c.table(
    TABLE_NAME,
    {
      id: c.varchar('id', { length: 128 }).notNull().primaryKey().$type<IdempotencyKeyId>(),
      idempotencyKey: c.varchar('idempotency_key', { length: 128 }).notNull(),
      procedurePath: c.varchar('procedure_path', { length: 255 }).notNull(),
      userId: c.text('user_id').notNull(),
      responseJson: c.json('response_json').notNull(),
      createdAt: c.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      expiresAt: c.timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (t) => [c.uniqueIndex(UNIQUE_INDEX_NAME).on(t.idempotencyKey, t.procedurePath, t.userId)],
  );
}

/** The Postgres idempotency table, in any schema. */
export type IdempotencyKeysTable = ReturnType<typeof createIdempotencyTable<'pg'>>;

/** The SQLite idempotency table. */
export type SqliteIdempotencyKeysTable = ReturnType<typeof createIdempotencyTable<'sqlite'>>;
