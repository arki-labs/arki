import { and, eq, gt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { IdempotencyKeysTable } from './idempotency-table';

const TTL_DAYS = 7;

export class IdempotencyRepository {
  constructor(
    private readonly db: NodePgDatabase<any>,
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
