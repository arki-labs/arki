/**
 * Debug Utilities for Testing
 *
 * Provides debugging helpers for inspecting database state,
 * queries, and test execution.
 *
 * Also provides runtime debug logging using @arki/logger/debug:
 * - DEBUG=testing:tester - Main tester lifecycle and operations
 * - DEBUG=testing:containers - Container startup and management
 * - DEBUG=testing:factories - Factory operations and data generation
 * - DEBUG=testing:* - All testing package logs
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import { createDebugLogger } from '@arki/logger/debug';

/**
 * Runtime debug logger for main tester operations
 */
export const debugTester = createDebugLogger('testing:tester');

/**
 * Runtime debug logger for container operations
 */
export const debugContainers = createDebugLogger('testing:containers');

/**
 * Runtime debug logger for factory operations
 */
export const debugFactories = createDebugLogger('testing:factories');

/**
 * Options for debug logging
 */
export interface DebugOptions {
  /**
   * Whether debug logging is enabled
   * @default process.env.DEBUG_TESTS === 'true'
   */
  enabled?: boolean;

  /**
   * Function to use for logging
   * @default console.log
   */
  logger?: (message: string, ...args: any[]) => void;
}

let debugEnabled = process.env.DEBUG_TESTS === 'true';
let debugLogger: (message: string, ...args: any[]) => void = console.log;

/**
 * Configure debug options globally
 *
 * @param options - Debug options
 *
 * @example
 * ```typescript
 * configureDebug({ enabled: true, logger: customLogger });
 * ```
 */
export function configureDebug(options: DebugOptions): void {
  if (options.enabled !== undefined) {
    debugEnabled = options.enabled;
  }
  if (options.logger) {
    debugLogger = options.logger;
  }
}

/**
 * Check if debug logging is enabled
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Log a debug message (only if debug is enabled)
 *
 * @param message - Message to log
 * @param args - Additional arguments
 *
 * @example
 * ```typescript
 * logDebug('Creating test user', { email: 'test@example.com' });
 * ```
 */
export function logDebug(message: string, ...args: any[]): void {
  if (debugEnabled) {
    debugLogger(`[DEBUG] ${message}`, ...args);
  }
}

/**
 * Log SQL query with parameters
 *
 * @param query - SQL query string
 * @param params - Query parameters
 *
 * @example
 * ```typescript
 * logQuery('SELECT * FROM users WHERE id = $1', ['usr_123']);
 * ```
 */
export function logQuery(query: string, params?: any[]): void {
  if (debugEnabled) {
    debugLogger(`[SQL] ${query}`);
    if (params && params.length > 0) {
      debugLogger('  Params:', params);
    }
  }
}

/**
 * Log the current state of an object
 *
 * @param label - Label for the state
 * @param state - Object to log
 *
 * @example
 * ```typescript
 * logState('User after update', user);
 * ```
 */
export function logState(label: string, state: any): void {
  if (debugEnabled) {
    debugLogger(`[STATE] ${label}:`, JSON.stringify(state, null, 2));
  }
}

/**
 * Dump all tables and their row counts from the database
 *
 * @param db - Database instance
 *
 * @example
 * ```typescript
 * await dumpDatabase(tester.db);
 * // Output:
 * // [DB DUMP] Table counts:
 * // - users: 5 rows
 * // - games: 10 rows
 * // - sessions: 25 rows
 * ```
 */
export async function dumpDatabase<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
): Promise<void> {
  if (!debugEnabled) return;

  try {
    const result = await db.execute<{ table_name: string; row_count: number }>(sql`
      SELECT
        schemaname || '.' || tablename as table_name,
        n_live_tup as row_count
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    debugLogger('[DB DUMP] Table counts:');
    for (const row of result.rows) {
      debugLogger(`  - ${row.table_name}: ${row.row_count} rows`);
    }
  } catch (error) {
    debugLogger('[DB DUMP] Error dumping database:', error);
  }
}

/**
 * Dump specific table contents
 *
 * @param db - Database instance
 * @param tableName - Name of the table to dump
 * @param limit - Maximum number of rows to display (default: 10)
 *
 * @example
 * ```typescript
 * await dumpTable(tester.db, 'users', 5);
 * ```
 */
export async function dumpTable<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  tableName: string,
  limit = 10,
): Promise<void> {
  if (!debugEnabled) return;

  try {
    const result = await db.execute(sql.raw(`SELECT * FROM ${tableName} LIMIT ${limit}`));

    debugLogger(`[TABLE DUMP] ${tableName} (showing ${Math.min(result.rows.length, limit)} rows):`);
    for (const row of result.rows) {
      debugLogger('  ', JSON.stringify(row, null, 2));
    }
  } catch (error) {
    debugLogger(`[TABLE DUMP] Error dumping table ${tableName}:`, error);
  }
}

/**
 * Create a timing tracker for measuring execution time
 *
 * @param label - Label for the operation
 * @returns Object with end() method to stop timing
 *
 * @example
 * ```typescript
 * const timer = timeOperation('Creating 100 users');
 * // ... do work ...
 * timer.end(); // Logs: "[TIMING] Creating 100 users: 1234ms"
 * ```
 */
export function timeOperation(label: string): { end: () => void } {
  const startTime = Date.now();

  return {
    end: () => {
      const duration = Date.now() - startTime;
      if (debugEnabled) {
        debugLogger(`[TIMING] ${label}: ${duration}ms`);
      }
    },
  };
}

/**
 * Log the start of a test section
 *
 * @param label - Section label
 *
 * @example
 * ```typescript
 * logSection('Setup test data');
 * // ... setup code ...
 * logSection('Execute test');
 * // ... test code ...
 * ```
 */
export function logSection(label: string): void {
  if (debugEnabled) {
    debugLogger(`\n${'='.repeat(60)}`);
    debugLogger(`[SECTION] ${label}`);
    debugLogger(`${'='.repeat(60)}`);
  }
}

/**
 * Create a scoped debug context
 *
 * @param context - Context label
 * @returns Debug functions scoped to the context
 *
 * @example
 * ```typescript
 * const debug = createDebugContext('UserTests');
 * debug.log('Creating user'); // [DEBUG] [UserTests] Creating user
 * debug.state('User', user);  // [STATE] [UserTests] User: {...}
 * ```
 */
export function createDebugContext(context: string) {
  return {
    log: (message: string, ...args: any[]) => {
      if (debugEnabled) {
        debugLogger(`[DEBUG] [${context}] ${message}`, ...args);
      }
    },
    query: (query: string, params?: any[]) => {
      if (debugEnabled) {
        debugLogger(`[SQL] [${context}] ${query}`);
        if (params && params.length > 0) {
          debugLogger('  Params:', params);
        }
      }
    },
    state: (label: string, state: any) => {
      if (debugEnabled) {
        debugLogger(`[STATE] [${context}] ${label}:`, JSON.stringify(state, null, 2));
      }
    },
    section: (label: string) => {
      if (debugEnabled) {
        debugLogger(`\n${'='.repeat(60)}`);
        debugLogger(`[${context}] ${label}`);
        debugLogger(`${'='.repeat(60)}`);
      }
    },
  };
}
