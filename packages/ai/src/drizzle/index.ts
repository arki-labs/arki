/**
 * Erasure outbox for a vector index, on Drizzle + Postgres.
 *
 * Every delete-sync site erases its points best-effort after commit, but the
 * DURABLE guarantee is a tombstone row written in the SAME transaction as the
 * row delete. The reconciler (`runVectorReconciliation`) drains the outbox
 * (delete point → remove row); a site clears its own tombstones when the
 * direct erasure succeeds, so rows only persist when that fast path failed
 * or was skipped.
 */
import type { PgAsyncDatabase, PgQueryResultHKT, PgSchema } from 'drizzle-orm/pg-core';
import { asc, inArray, sql } from 'drizzle-orm';
import { index, varchar } from 'drizzle-orm/pg-core';

import { createIdFactory } from '@arki/db/id';
import { instant } from '@arki/db/temporal';

import type { TombstoneStore } from '../vector-search/reconcile';

export type TombstoneTableOptions<TPrefix extends string> = {
  /** Table name, e.g. `vector_tombstones`; the index is `idx_${name}_created`. */
  name: string;
  /** Id prefix, e.g. `vtmb_`. */
  idPrefix: TPrefix;
};

/**
 * The tombstone table in the app's schema, plus its id factory.
 * `userId` has NO foreign key on purpose: an account-deletion cascade must
 * never wipe pending tombstones, or the user's points would orphan in the
 * index — the exact erasure hole this outbox closes.
 */
export function createTombstoneTable<TUserId extends string = string, TPrefix extends string = string>(
  schema: PgSchema,
  { name, idPrefix }: TombstoneTableOptions<TPrefix>,
) {
  const id = createIdFactory<TPrefix, `${TPrefix}${string}`>(idPrefix);
  const table = schema.table(
    name,
    {
      id: id.primaryColumn(),
      /** The point id to erase (the source row id). */
      pointId: varchar('point_id', { length: 256 }).notNull(),
      userId: varchar('user_id', { length: 256 }).$type<TUserId>().notNull(),
      createdAt: instant('created_at', { withTimezone: false })
        .notNull()
        .default(sql`now()`),
    },
    table => [index(`idx_${name}_created`).on(table.createdAt)],
  );
  return { table, id };
}

/** The base table shape (unbranded); a branded table from `createTombstoneTable<UserId, 'vtmb_'>` extends it. */
export type TombstoneTable = ReturnType<typeof createTombstoneTable<string, string>>['table'];

/** A Drizzle Postgres database or transaction — only what the outbox uses. */
export type TombstoneDb = Pick<PgAsyncDatabase<PgQueryResultHKT>, 'insert' | 'delete' | 'select'>;

// Statement chunking keeps large point sets (account deletion can carry tens
// of thousands of ids) under Postgres's 65535-bind-parameter ceiling.
/** 4 params/row → 20k params per statement. */
export const TOMBSTONE_INSERT_CHUNK = 5000;
/** 1 param/id. */
export const TOMBSTONE_DELETE_CHUNK = 10_000;

function chunksOf<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

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
