import { SQL } from 'bun';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { drizzle } from 'drizzle-orm/bun-sql';
import type { DrizzleConfig } from 'drizzle-orm/utils';

import { debugInit } from './debug';
import { env } from './env';

/**
 * Initialize database with Bun's native SQL driver
 * @param connectionString - PostgreSQL connection string
 * @param config - Drizzle configuration object
 * @returns Drizzle database instance
 */
export const initDb = <TSchema extends Record<string, unknown> = Record<string, never>>(
  connectionString: string,
  config: DrizzleConfig<TSchema>,
): BunSQLDatabase<TSchema> => {
  debugInit('[bun] Initializing database with connection string (logger: %s)', !!config.logger);

  const client = new SQL(connectionString);

  const db = drizzle({
    client,
    ...config,
  });

  debugInit('[bun] Database initialized successfully with Bun SQL driver');

  return db;
};

/**
 * Create a database connection using environment configuration with Bun SQL
 * @param config - Drizzle configuration object
 * @returns Drizzle database instance
 * @throws Error if DB_URL is not configured
 */
export function createDb<TSchema extends Record<string, unknown> = Record<string, never>>(
  config: DrizzleConfig<TSchema>,
): BunSQLDatabase<TSchema> {
  debugInit('[bun] Creating database from environment configuration');

  const connectionUrl = env.DB_URL;
  if (!connectionUrl) {
    debugInit('[bun] Database creation failed: DB_URL not configured');
    throw new Error('Database URL is not configured. Please set DB_URL environment variable.');
  }

  const db = initDb(connectionUrl, {
    ...config,
    logger: config.logger ?? (env.DB_LOGGING || env.NODE_ENV === 'development'),
  });

  debugInit('[bun] Database created successfully');

  return db;
}

// Re-export common utilities (from connection-options to avoid pg-native dependency)
export { getDbConnectionOptions, getDbConnectionParams } from './connection-options';

// Re-export types for convenience
export type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
