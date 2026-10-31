/**
 * The Postgres store for Foreman's nonces and receipts, for apps without a KV.
 * One Drizzle table: add it to the app's schema and migrate, then pass the store to
 * `createForemanRoute` (`@arki/admin/server`).
 *
 * ```ts
 * // schema.ts
 * export const foremanStore = foremanStoreTable({ schema }); // the app's pgSchema, or omit for public
 * // the fleet feature
 * const store = pgForemanStore({ db, table: foremanStore });
 * ```
 *
 * Every expiry is computed by the database (`now()`), so app instances with drifting clocks agree.
 * `drizzle-orm` is an optional peer: only this entry needs it.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT, PgSchema, PgTableFn } from 'drizzle-orm/pg-core';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { parse } from '@arki/schema';

import type { ForemanStore } from './foreman-route.ts';
import { DEFAULT_RECEIPT_TTL_SECONDS } from './receipts.ts';

export type ForemanStoreTableOptions = {
  /** The app's Postgres schema, when its tables live in one (`pgSchema('shop')`). Defaults to `public`. */
  readonly schema?: PgSchema;
  /** Defaults to `foreman_store`. */
  readonly name?: string;
};

/** The store's table. Add it to the app's Drizzle schema and migrate. */
export function foremanStoreTable({ schema, name = 'foreman_store' }: ForemanStoreTableOptions = {}) {
  const table: PgTableFn<string | undefined> = schema === undefined ? pgTable : schema.table;
  return table(
    name,
    {
      key: text('key').primaryKey(),
      value: jsonb('value').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    columns => [index(`${name}_expires_at_idx`).on(columns.expiresAt)],
  );
}

export type ForemanStoreTable = ReturnType<typeof foremanStoreTable>;

type AnyDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

/** The Drizzle surface the store uses. Structural: any Postgres Drizzle database fits, whatever its driver. */
export type ForemanStoreDb = {
  readonly select: AnyDb['select'];
  readonly insert: AnyDb['insert'];
  readonly delete: AnyDb['delete'];
};

export type PgForemanStoreOptions = { readonly db: ForemanStoreDb; readonly table: ForemanStoreTable };

/** An expiry `seconds` from now, on the database clock. */
const expiresIn = (seconds: number) => sql`now() + ${seconds} * interval '1 second'`;

/**
 * A {@link ForemanStore} on Postgres. `setIfNotExists` is one upsert that takes a free key or an
 * expired one, so of two instances racing for one nonce exactly one wins. It first deletes expired
 * rows, so the table holds only the nonces of the last few minutes and the receipts of the last 30 days.
 */
export function pgForemanStore({ db, table }: PgForemanStoreOptions): ForemanStore {
  return {
    async get(key, schema) {
      const rows = await db
        .select({ value: table.value })
        .from(table)
        .where(and(eq(table.key, key), gt(table.expiresAt, sql`now()`)))
        .limit(1);
      const value: unknown = rows[0]?.value;
      return value === undefined || value === null ? undefined : parse(schema, value);
    },
    async set(key, value, expirationSeconds = DEFAULT_RECEIPT_TTL_SECONDS) {
      await db
        .insert(table)
        .values({ key, value, expiresAt: expiresIn(expirationSeconds) })
        .onConflictDoUpdate({ target: table.key, set: { value, expiresAt: expiresIn(expirationSeconds) } });
      return true;
    },
    async setIfNotExists(key, value, expirationSeconds) {
      await db.delete(table).where(lte(table.expiresAt, sql`now()`));
      const taken = await db
        .insert(table)
        .values({ key, value, expiresAt: expiresIn(expirationSeconds) })
        .onConflictDoUpdate({
          target: table.key,
          set: { value, expiresAt: expiresIn(expirationSeconds) },
          setWhere: lte(table.expiresAt, sql`now()`),
        })
        .returning({ key: table.key });
      return taken.length === 1;
    },
  };
}
