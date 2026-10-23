/**
 * Erasure outbox for a vector index, on Drizzle + SQLite (libSQL).
 *
 * The SQLite twin of `@arki/ai/drizzle`: the same table (`createTombstoneTable`
 * with `sqliteColumns()`), the same behavior, SQLite's own query builders.
 * Timestamps keep milliseconds, so rows written in the same millisecond drain
 * in id order.
 */
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';
import { asc, inArray } from 'drizzle-orm';

import type { TombstoneStore } from '../vector-search/reconcile';
import type { createTombstoneTable } from './tables';
import { chunksOf, TOMBSTONE_DELETE_CHUNK, TOMBSTONE_INSERT_CHUNK } from './chunks';

export { createTombstoneTable, type TombstoneTableOptions } from './tables';
export { TOMBSTONE_DELETE_CHUNK, TOMBSTONE_INSERT_CHUNK } from './chunks';

/** The base table shape (unbranded); a branded table from `createTombstoneTable<'sqlite', UserId, 'vtmb_'>` extends it. */
export type SqliteTombstoneTable = ReturnType<typeof createTombstoneTable<'sqlite', string, string>>['table'];

/** A Drizzle SQLite database or transaction — only what the outbox uses. */
export type SqliteTombstoneDb = Pick<SQLiteAsyncDatabase<'async', unknown>, 'insert' | 'delete' | 'select'>;

/** The outbox helpers over one SQLite tombstone table. Ids keep the table's brands. */
export function sqliteTombstoneOutbox<TTable extends SqliteTombstoneTable>(table: TTable) {
  type TombstoneId = TTable['$inferSelect']['id'];
  type TombstoneUserId = TTable['$inferSelect']['userId'];
  // The statements run on the base shape; the brands come back through `TTable['$inferSelect']`.
  const base: SqliteTombstoneTable = table;

  return {
    /** Insert one tombstone per point id, INSIDE the caller's transaction. */
    async write(tx: SqliteTombstoneDb, userId: TombstoneUserId, pointIds: readonly string[]): Promise<void> {
      if (pointIds.length === 0) return;
      for (const chunk of chunksOf(pointIds, TOMBSTONE_INSERT_CHUNK)) {
        await tx.insert(base).values(chunk.map(pointId => ({ pointId, userId })));
      }
    },

    /** Remove tombstones after their points were erased directly (fast path). */
    async clear(dbOrTx: SqliteTombstoneDb, pointIds: readonly string[]): Promise<void> {
      if (pointIds.length === 0) return;
      for (const chunk of chunksOf(pointIds, TOMBSTONE_DELETE_CHUNK)) {
        await dbOrTx.delete(base).where(inArray(base.pointId, chunk));
      }
    },

    /** The reconciler's view of the outbox, bound to `db`. */
    store(db: SqliteTombstoneDb): TombstoneStore<TombstoneId> {
      return {
        // (createdAt, id) ordering — createdAt alone is non-deterministic on tied timestamps
        // (SQLite keeps milliseconds, so ties are common) and would break drain paging.
        list: limit =>
          db
            .select({ id: table.id, pointId: table.pointId })
            .from(base)
            .orderBy(asc(base.createdAt), asc(base.id))
            .limit(limit),
        remove: async ids => {
          if (ids.length === 0) return;
          await db.delete(base).where(inArray(base.id, [...ids]));
        },
      };
    },
  };
}
