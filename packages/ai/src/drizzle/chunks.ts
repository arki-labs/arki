/**
 * Statement chunking shared by both dialects' outbox. Large point sets
 * (account deletion can carry tens of thousands of ids) stay under the
 * database's bind-parameter ceiling (65535 on Postgres, 32766 on SQLite).
 */

/** 4 params/row → 20k params per statement. */
export const TOMBSTONE_INSERT_CHUNK = 5000;
/** 1 param/id. */
export const TOMBSTONE_DELETE_CHUNK = 10_000;

/** Split `values` into arrays of at most `size` items, in order. */
export function chunksOf<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
