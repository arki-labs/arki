/** The message table of the SQLite backend: plain Drizzle `sqliteTable`. */
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { sqliteNowMs } from '@arki/db/sqlite';

/**
 * The messages table: `id` (auto-increment, the subscribers' cursor), `channel`,
 * `payload` and `createdAt` (the database clock, used for retention). Export it
 * from your schema so your migrations create it.
 *
 * @example
 * ```ts skip="needs a database"
 * export const pubsubMessages = pubsubTable();
 * ```
 */
export function pubsubTable(name = 'arki_pubsub') {
  return sqliteTable(
    name,
    {
      id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
      channel: text('channel').notNull(),
      payload: text('payload').notNull(),
      createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sqliteNowMs),
    },
    table => [index(`${name}_created_at_idx`).on(table.createdAt)],
  );
}

/** The table {@link pubsubTable} builds. */
export type PubsubTable = ReturnType<typeof pubsubTable>;
