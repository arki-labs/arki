/**
 * Erasure outbox for a vector index, on Drizzle + Postgres (the SQLite twin is `@arki/ai/drizzle/sqlite`).
 *
 * Every delete-sync site erases its points best-effort after commit, but the
 * DURABLE guarantee is a tombstone row written in the SAME transaction as the
 * row delete. The reconciler (`runVectorReconciliation`) drains the outbox
 * (delete point → remove row); a site clears its own tombstones when the
 * direct erasure succeeds, so rows only persist when that fast path failed
 * or was skipped.
 */
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { asc, inArray } from 'drizzle-orm';

import type { TombstoneStore } from '../vector-search/reconcile';
import type { createTombstoneTable } from './tables';
import { chunksOf, TOMBSTONE_DELETE_CHUNK, TOMBSTONE_INSERT_CHUNK } from './chunks';

export { createTombstoneTable, type TombstoneTableOptions } from './tables';
export { TOMBSTONE_DELETE_CHUNK, TOMBSTONE_INSERT_CHUNK } from './chunks';

/** The base table shape (unbranded); a branded table from `createTombstoneTable<UserId, 'vtmb_'>` extends it. */
export type TombstoneTable = ReturnType<typeof createTombstoneTable<'pg', string, string>>['table'];

/** A Drizzle Postgres database or transaction — only what the outbox uses. */
export type TombstoneDb = Pick<PgAsyncDatabase<PgQueryResultHKT>, 'insert' | 'delete' | 'select'>;

/** The outbox helpers over one tombstone table. Ids keep the table's brands. */
export function tombstoneOutbox<TTable extends TombstoneTable>(table: TTable) {
  type TombstoneId = TTable['$inferSelect']['id'];
  type TombstoneUserId = TTable['$inferSelect']['userId'];
  // The statements run on the base shape; the brands come back through `TTable['$inferSelect']`.
  const base: TombstoneTable = table;

  return {
    /** Insert one tombstone per point id, INSIDE the caller's transaction. */
    async write(tx: TombstoneDb, userId: TombstoneUserId, pointIds: readonly string[]): Promise<void> {
      if (pointIds.length === 0) return;
      for (const chunk of chunksOf(pointIds, TOMBSTONE_INSERT_CHUNK)) {
        await tx.insert(base).values(chunk.map(pointId => ({ pointId, userId })));
      }
    },

    /** Remove tombstones after their points were erased directly (fast path). */
    async clear(dbOrTx: TombstoneDb, pointIds: readonly string[]): Promise<void> {
      if (pointIds.length === 0) return;
      for (const chunk of chunksOf(pointIds, TOMBSTONE_DELETE_CHUNK)) {
        await dbOrTx.delete(base).where(inArray(base.pointId, chunk));
      }
    },

    /** The reconciler's view of the outbox, bound to `db`. */
    store(db: TombstoneDb): TombstoneStore<TombstoneId> {
      return {
        // (createdAt, id) ordering — createdAt alone is non-deterministic on
        // tied timestamps and would break drain paging.
        // Fields come from `table` (branded id); the FROM clause uses the base shape.
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
