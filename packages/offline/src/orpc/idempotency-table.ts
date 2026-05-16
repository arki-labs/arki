import { nanoid } from 'nanoid';
import { jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import type { PgSchema } from 'drizzle-orm/pg-core';

export type IdempotencyKeyId = `idk_${string}`;

const createIdempotencyKeyId = (): IdempotencyKeyId => `idk_${nanoid()}`;

const TABLE_NAME = 'offline_idempotency_keys';
const UNIQUE_INDEX_NAME = 'offline_idk_key_path_user_idx';

function buildColumns() {
  return {
    id: varchar('id', { length: 128 })
      .notNull()
      .primaryKey()
      .$type<IdempotencyKeyId>()
      .$defaultFn(createIdempotencyKeyId),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    procedurePath: varchar('procedure_path', { length: 255 }).notNull(),
    userId: text('user_id').notNull(),
    responseJson: jsonb('response_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  };
}

export const idempotencyKeys = pgTable(TABLE_NAME, buildColumns(), (t) => [
  uniqueIndex(UNIQUE_INDEX_NAME).on(t.idempotencyKey, t.procedurePath, t.userId),
]);

export function createIdempotencyTable(schema: PgSchema) {
  return schema.table(TABLE_NAME, buildColumns(), (t) => [
    uniqueIndex(UNIQUE_INDEX_NAME).on(t.idempotencyKey, t.procedurePath, t.userId),
  ]);
}

export type IdempotencyKeysTable =
  | typeof idempotencyKeys
  | ReturnType<typeof createIdempotencyTable>;
