import type { DrizzleConfig } from 'drizzle-orm/utils';

import { getDbConnectionOptions } from './connection-options';
import { debugFactory } from './debug';
import { env } from './env';
import { initDbWithOptions } from './init';

/**
 * Create a database connection using environment configuration
 * @param config - Drizzle configuration object
 * @returns Drizzle database instance
 * @throws Error if DB_URL is configured
 */
export function createDb<TSchema extends Record<string, unknown> = Record<string, never>>(
  config: DrizzleConfig<TSchema>,
) {
  debugFactory('[factory] Creating database from environment configuration');

  const connectionUrl = env.DB_URL;
  if (!connectionUrl) {
    debugFactory('[factory] Database creation failed: DB_URL not configured');
    throw new Error('Database URL is not configured. Please set DB_URL environment variable.');
  }

  const connectionOptions = getDbConnectionOptions();

  debugFactory('[factory] Connection options (min: %d, max: %d, idleTimeout: %dms, connTimeout: %dms)',
    connectionOptions.min, connectionOptions.max,
    connectionOptions.idleTimeoutMillis, connectionOptions.connectionTimeoutMillis);

  const db = initDbWithOptions(connectionOptions, {
    ...config,
    logger: config.logger ?? (env.DB_LOGGING || env.NODE_ENV === 'development'),
  });

  debugFactory('[factory] Database created successfully');

  return db;
}

// Re-export connection options utilities
export { getDbConnectionOptions, getDbConnectionParams } from './connection-options';
