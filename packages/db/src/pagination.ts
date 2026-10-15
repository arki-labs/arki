/**
 * Keyset pagination, the server half. `keyset({ createdAt: 'desc', id: 'desc' })`
 * from `@arki/contracts` declares the order and the cursor; `keysetQuery`
 * turns it into `ORDER BY`, the "after this cursor" predicate, `LIMIT n + 1`
 * and the page. Filters (ownership included) stay in your query, untouched.
 *
 * Timestamps: a JS `Date` keeps milliseconds, Postgres `timestamp` keeps
 * microseconds by default. A cursor rounded to the millisecond can skip rows
 * that differ only in microseconds, so declare keyset timestamp columns with
 * `{ precision: 3 }` (or `mode: 'string'`, which keeps all six digits).
 */
import type { AnyColumn, SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gt, gte, lt, lte, or } from 'drizzle-orm';

import type { CursorValues, Keyset, KeysetOrder, Page } from '@arki/contracts';

/** The column behind each key of the order. A table whose columns carry the key names fits as is. */
export type KeysetColumns<O extends KeysetOrder> = { readonly [K in keyof O]: AnyColumn };

/** What {@link keysetQuery} returns: the pieces of one paged query. */
export type KeysetQuery<O extends KeysetOrder> = {
  /** `ORDER BY` terms, most significant key first. */
  readonly orderBy: SQL[];
  /** Rows strictly after the cursor in this order; `undefined` (no condition) for the first page. */
  readonly after: (cursor: string | undefined) => SQL | undefined;
  /** The `LIMIT` to use: one more than the page, so the extra row tells whether another page exists. */
  readonly take: (limit: number) => number;
  /** Cut the `take(limit)` rows down to the page and compute `nextCursor` from its last row. */
  readonly page: <R extends CursorValues<O>>(rows: readonly R[], limit: number) => Page<R>;
};

/**
 * The query pieces for one keyset. Pass the table when its columns are named
 * like the keys (`keysetQuery(storyOrder, stories)`), or a map otherwise.
 *
 * @example
 * ```ts
 * const byNewest = keysetQuery(storyOrder, stories);
 *
 * async listMine(userId: UserId, { cursor, limit }: { cursor?: string; limit: number }) {
 *   const rows = await this.db
 *     .select()
 *     .from(stories)
 *     .where(and(eq(stories.userId, userId), byNewest.after(cursor)))
 *     .orderBy(...byNewest.orderBy)
 *     .limit(byNewest.take(limit));
 *   return byNewest.page(rows, limit);   // { items, nextCursor }
 * }
 * ```
 */
export function keysetQuery<O extends KeysetOrder>(keys: Keyset<O>, columns: KeysetColumns<O>): KeysetQuery<O> {
  const terms = keys.keys.map(key => ({ key, column: columns[key], descending: keys.order[key] === 'desc' }));

  return {
    orderBy: terms.map(({ column, descending }) => (descending ? desc(column) : asc(column))),

    after: cursor => {
      if (cursor === undefined) return;
      const values = keys.decode(cursor);
      const parts = terms.map(term => ({ ...term, value: values[term.key] }));
      // Row R is after the cursor when, at the first key where they differ, R is
      // past it: (a > a0) OR (a = a0 AND b > b0) OR … ("past" is < for desc keys).
      const branches = parts.map((part, index) =>
        and(
          ...parts.slice(0, index).map(earlier => eq(earlier.column, earlier.value)),
          part.descending ? lt(part.column, part.value) : gt(part.column, part.value),
        ),
      );
      const [first] = parts;
      // Redundant on purpose: a plain bound on the first key lets Postgres use the
      // index as a range scan; the OR alone would make it look at every row.
      const bound =
        first === undefined ? undefined : first.descending ? lte(first.column, first.value) : gte(first.column, first.value);
      return and(bound, or(...branches));
    },

    take: limit => limit + 1,

    page: (rows, limit) => {
      if (rows.length <= limit) return { items: [...rows], nextCursor: null };
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      // `undefined` only for a zero-row page (`limit: 0`), which has nothing to continue from.
      return { items, nextCursor: last === undefined ? null : keys.encode(last) };
    },
  };
}
