import type { AnyRelations, EmptyRelations } from 'drizzle-orm';
import type { DrizzlePgConfig } from 'drizzle-orm/pg-core/utils';

import { getDbConnectionOptions } from './connection-options';
import { debugFactory } from './debug';
import { env } from './env';
import { initDbWithOptions } from './init';

/**
 * Create a database connection using environment configuration.
 * @param config - Drizzle pg configuration (relations + logger).
 * @throws Error if DB_URL is not configured.
 */
export function createDb<TRelations extends AnyRelations = EmptyRelations>(
  config: DrizzlePgConfig<TRelations>,
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

export { getDbConnectionOptions, getDbConnectionParams } from './connection-options';
