import { and, eq, gt } from 'drizzle-orm';
import type { AnyRelations } from 'drizzle-orm';
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';

import type { IdempotencyStoreFailure } from './idempotency-failures';
import { storeIdempotentResponse } from './idempotency-store';
import type { SqliteIdempotencyKeysTable } from './idempotency-table';

/** Any async SQLite drizzle database (libSQL) or transaction — only what the repository uses. */
export type SqliteIdempotencyDatabase = Pick<SQLiteAsyncDatabase<'async', unknown, AnyRelations>, 'select' | 'insert'>;

/** The SQLite twin of `IdempotencyRepository`: same cache, same 7-day window, SQLite's own query builders. */
export class SqliteIdempotencyRepository {
  constructor(
    private readonly db: SqliteIdempotencyDatabase,
    private readonly table: SqliteIdempotencyKeysTable,
  ) {}

  async find(key: string, path: string, userId: string): Promise<unknown> {
    const rows = await this.db
      .select({ responseJson: this.table.responseJson })
      .from(this.table)
      .where(
        and(
          eq(this.table.idempotencyKey, key),
          eq(this.table.procedurePath, path),
          eq(this.table.userId, userId),
          gt(this.table.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return rows[0]?.responseJson ?? null;
  }

  /** Cache a completed response; a failure never authorizes re-running its handler. */
  store(key: string, path: string, userId: string, response: unknown): Promise<void | IdempotencyStoreFailure> {
    return storeIdempotentResponse(key, path, userId, response, row =>
      this.db.insert(this.table).values(row).onConflictDoNothing(),
    );
  }
}
