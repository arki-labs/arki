/**
 * Finding the Postgres error inside whatever was thrown. Private to the package:
 * `errors.ts` and `transaction.ts` both read errors through it.
 *
 * Drivers disagree on where the SQLSTATE goes. node-postgres and PGlite put it
 * in `code`. Bun SQL puts `ERR_POSTGRES_SERVER_ERROR` in `code` and the
 * SQLSTATE in `errno`. Drizzle wraps all of them in `DrizzleQueryError`, which
 * has no `code` and keeps the driver error as `cause`.
 */

/** How far the walk follows `cause`. */
const MAX_CAUSE_DEPTH = 5;

/** Five characters with at least one digit: `23505`, `40P01`, `P0001`, `XX000`. Never a word like `ABORT`. */
const SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/;

/** The facts a caller decides on: the SQLSTATE and, when Postgres named one, the constraint. */
export type DatabaseErrorFacts = { readonly sqlState: string; readonly constraint: string | undefined };

/**
 * Walks `error`, then its `cause`, and stops at the FIRST object with a string
 * `code`: that object decides. Its SQLSTATE is `errno` (Bun) or else `code`
 * (node-postgres, PGlite). So a `DrizzleQueryError` defers to the driver error
 * inside it, while an `ORPCError('CONFLICT')` or an `ECONNRESET` is final even
 * when a database error sits deeper. Messages are never matched. A cycle, a deep
 * chain, a throwing getter or an `AggregateError` gives `undefined`.
 */
export function findDatabaseError(error: unknown): DatabaseErrorFacts | undefined {
  const seen = new Set<object>();
  let node: unknown = error;
  try {
    for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
      if (typeof node !== 'object' || node === null || seen.has(node) || node instanceof AggregateError) return;
      seen.add(node);
      const code: unknown = 'code' in node ? node.code : undefined;
      if (typeof code === 'string') {
        const errno: unknown = 'errno' in node ? node.errno : undefined;
        const sqlState =
          typeof errno === 'string' && SQLSTATE.test(errno) ? errno : SQLSTATE.test(code) ? code : undefined;
        if (sqlState === undefined) return;
        const constraint: unknown = 'constraint' in node ? node.constraint : undefined;
        return { sqlState, constraint: typeof constraint === 'string' ? constraint : undefined };
      }
      node = 'cause' in node ? node.cause : undefined;
    }
  } catch {
    // A getter threw while we looked. Not a database answer we can trust.
  }
  return;
}
