import type { AnyRelations, Logger } from 'drizzle-orm';

import { getDbConnectionOptions } from './connection-options.js';
import { debugFactory } from './debug.js';
import { env } from './env.js';
import { initDbWithOptions } from './init.js';

/**
 * Create a database connection using environment configuration.
 *
 * `relations` is required (mark the field even when empty) so TypeScript can
 * infer the precise relations type for `db.query.*` autocomplete. Use
 * `defineRelations(schema, callback)` to build the value.
 *
 * @throws Error if DB_URL is not configured.
 */
export function createDb<TRelations extends AnyRelations>(
  config: {
    relations: TRelations;
    logger?: boolean | Logger | undefined;
  },
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

  const db = initDbWithOptions<TRelations>(connectionOptions, {
    ...config,
    logger: config.logger ?? (env.DB_LOGGING || env.NODE_ENV === 'development'),
  });

  debugFactory('[factory] Database created successfully');

  return db;
}

export { getDbConnectionOptions, getDbConnectionParams } from './connection-options.js';
