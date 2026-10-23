/**
 * Finding the database error inside whatever was thrown, as a SQL-standard
 * SQLSTATE. Private to the package: `errors.ts` and `transaction.ts` both read
 * errors through it.
 *
 * Drivers disagree on where the code goes. node-postgres and PGlite put the
 * SQLSTATE in `code`. Bun SQL puts `ERR_POSTGRES_SERVER_ERROR` in `code` and the
 * SQLSTATE in `errno`. SQLite has no SQLSTATE: its drivers put a `SQLITE_*` name
 * (or node:sqlite's `ERR_SQLITE_ERROR`) in `code` and the extended result code in
 * `rawCode` (libSQL), `errcode` (node:sqlite) or `errno` (bun:sqlite), which
 * {@link SQLITE_SQLSTATE} translates. Drizzle wraps all of them in
 * `DrizzleQueryError`, which has no `code` and keeps the driver error as `cause`.
 */

/** How far the walk follows `cause`. */
const MAX_CAUSE_DEPTH = 5;

/** Five characters with at least one digit: `23505`, `40P01`, `P0001`, `XX000`. Never a word like `ABORT`. */
const SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/;

/**
 * SQLite extended result codes and the SQLSTATE that means the same to a caller.
 * `SQLITE_BUSY` means the write lock was taken and nothing ran: class 40, retry.
 * An unlisted code is not a database answer we act on.
 */
const SQLITE_SQLSTATE: Readonly<Record<number, string>> = {
  2067: '23505', // SQLITE_CONSTRAINT_UNIQUE
  1555: '23505', // SQLITE_CONSTRAINT_PRIMARYKEY
  787: '23503', // SQLITE_CONSTRAINT_FOREIGNKEY
  1299: '23502', // SQLITE_CONSTRAINT_NOTNULL
  275: '23514', // SQLITE_CONSTRAINT_CHECK
  5: '40001', // SQLITE_BUSY
  261: '40001', // SQLITE_BUSY_RECOVERY
  517: '40001', // SQLITE_BUSY_SNAPSHOT
  773: '40001', // SQLITE_BUSY_TIMEOUT
};

/** The facts a caller decides on: the SQLSTATE and, when Postgres named one, the constraint. */
export type DatabaseErrorFacts = { readonly sqlState: string; readonly constraint: string | undefined };

/**
 * Walks `error`, then its `cause`, and stops at the FIRST object with a string
 * `code`: that object decides. Its SQLSTATE is `errno` (Bun) or else `code`
 * (node-postgres, PGlite), or the translated SQLite code. So a
 * `DrizzleQueryError` defers to the driver error inside it, while an
 * `ORPCError('CONFLICT')` or an `ECONNRESET` is final even when a database error
 * sits deeper. Messages are never matched. A cycle, a deep chain, a throwing
 * getter or an `AggregateError` gives `undefined`. SQLite names columns, not
 * constraints, so a SQLite error never has a `constraint`.
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
        if (code.startsWith('SQLITE_') || code === 'ERR_SQLITE_ERROR') {
          const sqlState = sqliteSqlState(node);
          return sqlState === undefined ? undefined : { sqlState, constraint: undefined };
        }
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

/** The SQLSTATE for a SQLite driver error, from the first numeric extended result code it carries. */
function sqliteSqlState(node: object): string | undefined {
  const candidates: unknown[] = [
    'rawCode' in node ? node.rawCode : undefined, // libSQL
    'errcode' in node ? node.errcode : undefined, // node:sqlite
    'errno' in node ? node.errno : undefined, // bun:sqlite
  ];
  const code = candidates.find(value => typeof value === 'number');
  return typeof code === 'number' ? SQLITE_SQLSTATE[code] : undefined;
}
