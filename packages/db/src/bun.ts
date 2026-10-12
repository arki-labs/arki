import { SQL } from 'bun';
import type { AnyRelations } from 'drizzle-orm';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { drizzle } from 'drizzle-orm/bun-sql/postgres';
import type { DrizzlePgConfig } from 'drizzle-orm/pg-core/utils';

import { debugInit } from './debug.js';
import { env } from './env.js';

/**
 * Initialize database with Bun's native SQL driver.
 * @param connectionString - PostgreSQL connection string.
 * @param config - Drizzle pg configuration.
 */
export const initDb = <TRelations extends AnyRelations>(
  connectionString: string,
  config: Omit<DrizzlePgConfig<TRelations>, 'relations'> & { relations: TRelations },
): BunSQLDatabase<TRelations> => {
  debugInit('[bun] Initializing database with connection string (logger: %s)', !!config.logger);

  const client = new SQL(connectionString);

  const db = drizzle<TRelations>({ ...config, client });

  debugInit('[bun] Database initialized successfully with Bun SQL driver');

  return db;
};

/**
 * Create a database connection using environment configuration with Bun SQL.
 * @param config - Drizzle pg configuration.
 * @throws Error if DB_URL is not configured.
 */
export function createDb<TRelations extends AnyRelations>(
  config: Omit<DrizzlePgConfig<TRelations>, 'relations'> & { relations: TRelations },
): BunSQLDatabase<TRelations> {
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

export { getDbConnectionOptions, getDbConnectionParams } from './connection-options.js';

export type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
