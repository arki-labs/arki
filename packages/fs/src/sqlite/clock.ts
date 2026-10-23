/** The SQLite database clock, shared by the statements and the sweep's claim. */
import { sql } from 'drizzle-orm';

/**
 * The database clock in integer milliseconds, SQLite's `now()`. SQLite fixes
 * `'now'` for one statement, so every use inside a statement sees the same value.
 */
export const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
