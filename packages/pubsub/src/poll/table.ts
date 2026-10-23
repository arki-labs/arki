/** The message table of the poll backend, written once with the column kit for Postgres and SQLite. */
import type { ColumnKit, Dialect } from '@arki/db/columns';

/**
 * The messages table: `id` (auto-increment, the subscribers' cursor), `channel`,
 * `payload` and `createdAt` (set by the database clock, used for retention).
 * Pass `pgColumns()` or `sqliteColumns()` from `@arki/db/pg` / `@arki/db/sqlite`, and
 * add the table to your schema so migrations create it.
 *
 * @example
 * ```ts skip="needs a database"
 * export const pubsubMessages = pubsubTable(pgColumns());
 * ```
 */
export function pubsubTable<D extends Dialect>(c: ColumnKit<D>, name = 'arki_pubsub') {
  return c.table(
    name,
    {
      id: c.serial('id'),
      channel: c.text('channel').notNull(),
      payload: c.text('payload').notNull(),
      createdAt: c.timestamp('created_at').notNull().defaultNow(),
    },
    table => [c.index(`${name}_created_at_idx`).on(table.createdAt)],
  );
}

/** The table {@link pubsubTable} builds for dialect `D`. */
export type PubsubTable<D extends Dialect> = ReturnType<typeof pubsubTable<D>>;

/** A message row as the poll loop reads it (the same on both dialects). */
export type PubsubRow = Pick<PubsubTable<'pg'>['$inferSelect'], 'id' | 'channel' | 'payload'>;

/** How many rows one poll reads at most; the next poll goes on from there. */
export const POLL_BATCH = 1000;
