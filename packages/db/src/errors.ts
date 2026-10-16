/**
 * Questions about a Postgres error, answered the same way for every driver
 * (node-postgres, PGlite, Bun SQL) and through Drizzle's `DrizzleQueryError`.
 */
import { findDatabaseError } from './sql-state.js';

/** SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when the database refused a write because a unique index already holds
 * the value: the "insert, and answer CONFLICT on a duplicate" check. Pass
 * `constraint` to match one named index only.
 *
 * @example
 * try {
 *   await db.insert(Source).values(row);
 * } catch (error) {
 *   if (isUniqueViolation(error, 'idx_sources_user_sender')) throw new ORPCError('CONFLICT');
 *   throw error;
 * }
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const facts = findDatabaseError(error);
  if (facts?.sqlState !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || facts.constraint === constraint;
}
