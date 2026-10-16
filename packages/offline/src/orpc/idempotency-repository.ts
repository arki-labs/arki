import { and, eq, gt } from 'drizzle-orm';
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type { IdempotencyKeysTable } from './idempotency-table';

const TTL_DAYS = 7;

/** Any async Postgres drizzle database: node-postgres in production, PGlite in tests and local runs. */
export type IdempotencyDatabase = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

export class IdempotencyRepository {
  constructor(
    private readonly db: IdempotencyDatabase,
    private readonly table: IdempotencyKeysTable,
  ) {}

  async find(key: string, path: string, userId: string): Promise<unknown | null> {
    const rows = await this.db
      .select({ responseJson: this.table.responseJson })
      .from(this.table as typeof this.table)
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

  async store(key: string, path: string, userId: string, response: unknown): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + TTL_DAYS);

    await this.db
      .insert(this.table as typeof this.table)
      .values({
        idempotencyKey: key,
        procedurePath: path,
        userId,
        responseJson: response,
        expiresAt,
      })
      .onConflictDoNothing();
  }
}
