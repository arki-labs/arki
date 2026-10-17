import { debugFactory } from './debug.js';
import { env } from './env.js';
import { poolEnv } from './pool-env.js';

/** The pool settings from the environment, without the URL — readable with no `DB_URL` set. */
export function getPoolOptions() {
  return {
    min: poolEnv.DB_POOL_MIN,
    max: poolEnv.DB_POOL_MAX,
    idleTimeoutMillis: poolEnv.DB_POOL_IDLE_TIMEOUT,
    connectionTimeoutMillis: poolEnv.DB_POOL_CONNECTION_TIMEOUT,
    statement_timeout: poolEnv.DB_STATEMENT_TIMEOUT,
    query_timeout: poolEnv.DB_QUERY_TIMEOUT,
    idle_in_transaction_session_timeout: poolEnv.DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT,
  };
}

/**
 * Get database connection options from environment variables
 * @returns Connection options object for pg Pool
 */
export function getDbConnectionOptions() {
  debugFactory.debug('[factory] Retrieving database connection options from environment');

  const connectionUrl = env.DB_URL;
  const options = { connectionString: connectionUrl, ...getPoolOptions() };

  debugFactory.debug('[factory] Connection options retrieved (hasUrl: {hasUrl})', { hasUrl: !!connectionUrl });

  return options;
}

/**
 * Get individual database connection parameters from environment variables
 * Useful when DB_URL is not available but individual parameters are set
 * @returns Connection parameters object
 */
export function getDbConnectionParams() {
  debugFactory.debug('[factory] Retrieving database connection parameters from environment');

  const params = {
    user: poolEnv.PGUSER,
    password: poolEnv.PGPASSWORD,
    host: poolEnv.PGHOST,
    port: poolEnv.PGPORT,
    database: poolEnv.PGDATABASE,
    ssl: poolEnv.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: poolEnv.PGSSLMODE === 'verify-full' },
  };

  debugFactory.debug(
    '[factory] Connection parameters retrieved (host: {host}, port: {port}, database: {database}, ssl: {PGSSLMODE})',
    { host: params.host, port: params.port, database: params.database, PGSSLMODE: poolEnv.PGSSLMODE },
  );

  return params;
}
