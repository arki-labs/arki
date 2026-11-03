import { and, eq, gt } from 'drizzle-orm';
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type { IdempotencyStoreFailure } from './idempotency-failures.js';
import { storeIdempotentResponse } from './idempotency-store.js';
import type { IdempotencyKeysTable } from './idempotency-table.js';

/** Any async Postgres drizzle database: node-postgres in production, PGlite in tests and local runs. */
export type IdempotencyDatabase = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

export class IdempotencyRepository {
  constructor(
    private readonly db: IdempotencyDatabase,
    private readonly table: IdempotencyKeysTable,
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
