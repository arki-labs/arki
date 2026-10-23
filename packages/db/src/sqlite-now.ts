/** SQLite's clock in milliseconds, the form the column kit stores times in. */
import { sql } from 'drizzle-orm';

/**
 * The database's current time as integer milliseconds since the epoch: the
 * SQLite form of Postgres's `now()` for columns the kit stores as milliseconds
 * (`timestamp`, `instant`). One clock for every writer, unlike `Date.now()`.
 */
export const sqliteNowMs = sql<number>`(cast(unixepoch('subsec') * 1000 as integer))`;
