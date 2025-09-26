import type { DrizzleConfig } from 'drizzle-orm/utils';
import { env } from './env';
import { initDb } from './init';

/**
 * Create a database connection using environment configuration
 * @param config - Drizzle configuration object
 * @returns Drizzle database instance
 * @throws Error if neither DATABASE_URL nor DB_URL is configured
 * @description Prefers DATABASE_URL over DB_URL for broader platform compatibility
 */
export function createDb<TSchema extends Record<string, unknown> = Record<string, never>>(
  config: DrizzleConfig<TSchema>,
) {
  const connectionUrl = env.DATABASE_URL ?? env.DB_URL;
  if (!connectionUrl) {
    throw new Error('Database URL is not configured. Please set either DATABASE_URL or DB_URL environment variable.');
  }

  return initDb(connectionUrl, {
    ...config,
    logger: config.logger ?? (env.DB_LOGGING || env.NODE_ENV === 'development'),
  });
}

/**
 * Get database connection options from environment variables
 * @returns Connection options object for pg Pool
 * @description Prefers DATABASE_URL over DB_URL for connection string
 */
export function getDbConnectionOptions() {
  const connectionUrl = env.DATABASE_URL ?? env.DB_URL;
  return {
    connectionString: connectionUrl,
    min: env.DB_POOL_MIN,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT,
    connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT,
    statement_timeout: env.DB_STATEMENT_TIMEOUT,
    query_timeout: env.DB_QUERY_TIMEOUT,
    idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT,
  };
}

/**
 * Get individual database connection parameters from environment variables
 * Useful when DB_URL is not available but individual parameters are set
 * @returns Connection parameters object
 */
export function getDbConnectionParams() {
  return {
    user: env.PGUSER,
    password: env.PGPASSWORD,
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: env.PGSSLMODE === 'verify-full' },
  };
}
