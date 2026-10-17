import type { AnyRelations, Logger } from 'drizzle-orm';

import { getPoolOptions } from './connection-options.js';
import { debugFactory } from './debug.js';
import { env } from './env.js';
import { initDbWithOptions } from './init.js';
import { poolEnv } from './pool-env.js';

/**
 * Create a database connection using environment configuration.
 * `url` overrides `DB_URL`; the pool settings still come from the env. With
 * `url`, `DB_URL` is never read, so it may be unset.
 *
 * `relations` is required (mark the field even when empty) so TypeScript can
 * infer the precise relations type for `db.query.*` autocomplete. Use
 * `defineRelations(schema, callback)` to build the value.
 *
 * @throws Error if neither `url` nor DB_URL is configured.
 */
export function createDb<TRelations extends AnyRelations>({
  url,
  ...config
}: {
  relations: TRelations;
  logger?: boolean | Logger | undefined;
  url?: string | undefined;
}) {
  debugFactory.debug('[factory] Creating database from environment configuration');

  const connectionUrl = url ?? env.DB_URL;
  if (!connectionUrl) {
    debugFactory.debug('[factory] Database creation failed: DB_URL not configured');
    throw new Error('Database URL is not configured. Please set DB_URL environment variable.');
  }

  const connectionOptions = { ...getPoolOptions(), connectionString: connectionUrl };

  debugFactory.debug(
    '[factory] Connection options (min: {min}, max: {max}, idleTimeout: {idleTimeoutMillis}ms, connTimeout: {connectionTimeoutMillis}ms)',
    {
      min: connectionOptions.min,
      max: connectionOptions.max,
      idleTimeoutMillis: connectionOptions.idleTimeoutMillis,
      connectionTimeoutMillis: connectionOptions.connectionTimeoutMillis,
    },
  );

  const db = initDbWithOptions<TRelations>(connectionOptions, {
    ...config,
    logger: config.logger ?? (poolEnv.DB_LOGGING || poolEnv.NODE_ENV === 'development'),
  });

  debugFactory.debug('[factory] Database created successfully');

  return db;
}

export { getDbConnectionOptions, getDbConnectionParams } from './connection-options.js';
