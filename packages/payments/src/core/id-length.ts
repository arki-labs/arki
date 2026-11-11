import { is } from 'drizzle-orm';
import { getTableConfig, pgTable, PgVarchar } from 'drizzle-orm/pg-core';

import { defineId, z } from '@arki/contracts';
import { idColumns } from '@arki/db/id';
import { invariant } from '@arki/failure';

/**
 * The most characters an id column holds. It is read from the column `idColumns` builds, so the
 * limit has one source: every payments id column (`id`, references, foreign keys) comes from it.
 */
export const ID_COLUMN_LENGTH: number = (() => {
  const [column] = getTableConfig(
    pgTable('id_length_probe', { id: idColumns(defineId('probe')).reference('id') }),
  ).columns;
  invariant(
    column !== undefined && is(column, PgVarchar) && column.length !== undefined,
    'idColumns builds a varchar(n) column',
  );
  return column.length;
})();

/**
 * Whether an id fits an id column. Postgres counts characters (code points) in a `varchar(n)`, so
 * 200 emoji fit a 256 column although they take 400 UTF-16 units.
 */
export function fitsIdColumn(id: string): boolean {
  if (id.length <= ID_COLUMN_LENGTH) return true;
  if (id.length > ID_COLUMN_LENGTH * 2) return false;
  let characters = 0;
  for (const _ of id) characters++;
  return characters <= ID_COLUMN_LENGTH;
}

/** An id schema that also refuses an id its column cannot hold, as `schema.invalid_input` (else the write fails with SQLSTATE 22001). */
export function boundedIdSchema<S extends z.ZodType<string>>(schema: S) {
  return schema.refine(fitsIdColumn, `An id cannot be longer than ${ID_COLUMN_LENGTH} characters`);
}
