/**
 * The lease table. Apps may run `ensureLockTable(db)` at boot, or copy
 * `LEASE_TABLE_SQL` into their own migrations.
 *
 * One row per key. The row is never deleted: `generation` lives in it, and a
 * deleted row would restart the fence at 1. `permits_limit` is for semaphores
 * (Phase 2); a mutex row leaves it NULL.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { LockError } from '../errors.js';

export const DEFAULT_LEASE_TABLE = 'arki_lock';

/** `name` or `schema.name`; plain identifiers only, so the name is safe to quote. */
export const tableNameSchema = z
  .string()
  .regex(/^[A-Z_]\w{0,62}(\.[A-Z_]\w{0,62})?$/i, 'must be "name" or "schema.name"');

/** The table name as a quoted SQL identifier. Throws `LockError{code:'config'}` for anything else. */
export function tableIdentifier(table: string): SQL {
  const parsed = tableNameSchema.safeParse(table);
  if (!parsed.success) {
    throw new LockError({
      code: 'config',
      message: `lease table ${JSON.stringify(table)} ${parsed.error.issues.map(issue => issue.message).join(', ')}`,
      remediation: 'Pass a plain table name such as "arki_lock" or "app.locks".',
    });
  }
  return sql.join(
    parsed.data.split('.').map(part => sql.identifier(part)),
    sql.raw('.'),
  );
}

/** The DDL for the default table name. */
export const LEASE_TABLE_SQL = leaseTableSql(DEFAULT_LEASE_TABLE);

/** The DDL for `table`, as text. Idempotent. */
export function leaseTableSql(table: string): string {
  const parsed = tableNameSchema.safeParse(table);
  if (!parsed.success) {
    throw new LockError({
      code: 'config',
      message: `lease table ${JSON.stringify(table)} ${parsed.error.issues.map(issue => issue.message).join(', ')}`,
      remediation: 'Pass a plain table name such as "arki_lock" or "app.locks".',
    });
  }
  const quoted = parsed.data
    .split('.')
    .map(part => `"${part}"`)
    .join('.');
  return `CREATE TABLE IF NOT EXISTS ${quoted} (
  key           text        PRIMARY KEY,
  token         text,
  generation    bigint      NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  permits_limit integer
);`;
}
