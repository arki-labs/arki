import type { DrizzleConfig } from 'drizzle-orm/utils';
// import postgres from 'postgres';
import type { PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { debugInit } from './debug';

const { native } = pg;

if (!native) {
  debugInit('[init] pg-native package not found');
  throw new Error('Please install the pg-native package');
}

debugInit('[init] Using pg-native for database connections');
const { Pool } = native;

// const client = postgres(connectionString, {
//   // Connection Pool Settings
//   max: 20,                    // Maximum number of connections in the pool
// });

export const initDb = <TSchema extends Record<string, unknown> = Record<string, never>>(
  connectionString: string,
  config: DrizzleConfig<TSchema>,
) => {
  debugInit('[init] Initializing database with connection string (logger: %s)', !!config.logger);

  const client = new Pool({
    connectionString,
  });

  const db = drizzle(client, config);
  debugInit('[init] Database initialized successfully');

  return db;
};

export const initDbWithOptions = <TSchema extends Record<string, unknown> = Record<string, never>>(
  poolConfig: PoolConfig,
  config: DrizzleConfig<TSchema>,
) => {
  debugInit('[init] Initializing database with pool config (min: %d, max: %d, logger: %s)',
    poolConfig.min ?? 0, poolConfig.max ?? 10, !!config.logger);

  const client = new Pool(poolConfig);

  const db = drizzle(client, config);
  debugInit('[init] Database initialized with custom pool configuration');

  return db;
};

// Re-export factory functions
export { createDb, getDbConnectionOptions, getDbConnectionParams } from './factory';
