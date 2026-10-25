/**
 * The tombstone table, written once for every dialect.
 *
 * Pass `pgColumns(schema)` from `@arki/db/pg` or `sqliteColumns()` from
 * `@arki/db/sqlite`. This file imports no dialect runtime, so one module
 * serves both.
 */
import type { IdDeclaration } from '@arki/contracts';
import type { ColumnKit, Dialect } from '@arki/db/columns';
import type { StandardSchemaV1 } from '@arki/schema';
import { defineId } from '@arki/contracts';

export type TombstoneTableOptions<TPrefix extends string, TUserId extends string> = {
  /** Table name, e.g. `vector_tombstones`; the index is `idx_${name}_created`. */
  name: string;
  /** Id prefix, e.g. `vtmb_`; arbitrary stored prefix bytes, including empty strings, are preserved. */
  idPrefix: TPrefix;
  /**
   * The app's user-id declaration, e.g. `defineId('usr_')`; `user_id` is typed by its schema's output.
   * Any Standard Schema works (Zod, Valibot, ArkType).
   */
  userId: { readonly schema: StandardSchemaV1<unknown, TUserId> };
};

/**
 * The tombstone table for one dialect's column kit, plus its id factory.
 * `userId` has NO foreign key on purpose: an account-deletion cascade must
 * never wipe pending tombstones, or the user's points would orphan in the
 * index — the exact erasure hole this outbox closes.
 */
export function createTombstoneTable<D extends Dialect, TPrefix extends string, TUserId extends string>(
  c: ColumnKit<D>,
  { name, idPrefix }: TombstoneTableOptions<TPrefix, TUserId>,
) {
  // Named so the published types say `IdDeclaration` instead of spelling out its Zod schema.
  const id: IdDeclaration<TPrefix> = defineId(idPrefix);
  const table = c.table(
    name,
    {
      id: c.id(id).primaryColumn(),
      /** The point id to erase (the source row id). */
      pointId: c.varchar('point_id', { length: 256 }).notNull(),
      userId: c.varchar('user_id', { length: 256 }).$type<TUserId>().notNull(),
      createdAt: c.instant('created_at', { withTimezone: false }).notNull().defaultNow(),
    },
    t => [c.index(`idx_${name}_created`).on(t.createdAt)],
  );
  return { table, id };
}
