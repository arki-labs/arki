import { and, eq, gt } from 'drizzle-orm';
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

import { isFailure, UnexpectedDefect } from '@arki/failure';

import { idempotencyKeyId } from './idempotency-id';
import { IdempotencyStoreUnconfirmed } from './idempotency-failures';
import type { IdempotencyStoreFailure } from './idempotency-failures';
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

  /** Cache a completed response; a failure never authorizes re-running its handler. */
  async store(key: string, path: string, userId: string, response: unknown): Promise<void | IdempotencyStoreFailure> {
    let span: Span | undefined;
    observe(() => { span = trace.getTracer('@arki/offline').startSpan('offline.idempotency.store'); });
    let execution: Promise<void | IdempotencyStoreFailure> | undefined;
    const executeOnce = async (): Promise<void | IdempotencyStoreFailure> => {
      let result: IdempotencyStoreFailure | undefined;
      try {
        const id = idempotencyKeyId.create();
        if (isFailure(id)) {
          result = id;
        } else {
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + TTL_DAYS);
          try {
            await this.db.insert(this.table).values({
              id,
              idempotencyKey: key,
              procedurePath: path,
              userId,
              responseJson: response,
              expiresAt,
            }).onConflictDoNothing();
          } catch (error) {
            result = IdempotencyStoreUnconfirmed({ cause: error });
          }
        }
      } catch (error) {
        result = UnexpectedDefect({ cause: error });
      }
      if (isFailure(result)) {
        const failure = result;
        observe(() => { span?.setAttribute('failure.code', failure.code); });
        observe(() => { span?.setStatus({ code: SpanStatusCode.ERROR, message: failure.code }); });
      }
      observe(() => { span?.end(); });
      return result;
    };
    // Reserve ownership before any provider/reporter can reenter the context callback.
    const execute = () => (execution ??= Promise.resolve().then(executeOnce));
    // A faulty context manager may omit/repeat the callback or throw after invoking it.
    // Always return the one owned execution, even when telemetry fails.
    observe(() => {
      if (span !== undefined) void Promise.resolve(context.with(trace.setSpan(context.active(), span), execute)).catch(() => {
        // Observe rejected work from a defective context manager; execute() owns the outcome.
      });
    });
    return execute();
  }
}

/** App-owned telemetry cannot change cache writes or their returned outcomes. */
function observe(report: () => void): void {
  try { report(); } catch { /* Best-effort reporting. */ }
}
