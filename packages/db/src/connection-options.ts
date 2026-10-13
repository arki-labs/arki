import { debugFactory } from './debug.js';
import { env } from './env.js';

/**
 * Get database connection options from environment variables
 * @returns Connection options object for pg Pool
 */
export function getDbConnectionOptions() {
  debugFactory('[factory] Retrieving database connection options from environment');

  const connectionUrl = env.DB_URL;
  const options = {
    connectionString: connectionUrl,
    min: env.DB_POOL_MIN,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT,
    connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT,
    statement_timeout: env.DB_STATEMENT_TIMEOUT,
    query_timeout: env.DB_QUERY_TIMEOUT,
    idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT,
  };

  debugFactory('[factory] Connection options retrieved (hasUrl: %s)', !!connectionUrl);

  return options;
}

/**
 * Get individual database connection parameters from environment variables
 * Useful when DB_URL is not available but individual parameters are set
 * @returns Connection parameters object
 */
export function getDbConnectionParams() {
  debugFactory('[factory] Retrieving database connection parameters from environment');

  const params = {
    user: env.PGUSER,
    password: env.PGPASSWORD,
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: env.PGSSLMODE === 'verify-full' },
  };

  debugFactory('[factory] Connection parameters retrieved (host: %s, port: %d, database: %s, ssl: %s)',
    params.host, params.port, params.database, env.PGSSLMODE);

  return params;
}
