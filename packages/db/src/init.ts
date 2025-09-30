import { drizzle } from 'drizzle-orm/node-postgres';
import type { DrizzleConfig } from 'drizzle-orm/utils';
// import postgres from 'postgres';
import type { PoolConfig } from 'pg';
import pg from 'pg';

const { native } = pg;

if (!native) {
  throw new Error('Please install the pg-native package');
}

const { Pool } = native;

// const client = postgres(connectionString, {
//   // Connection Pool Settings
//   max: 20,                    // Maximum number of connections in the pool
// });

export const initDb = <TSchema extends Record<string, unknown> = Record<string, never>>(
  connectionString: string,
  config: DrizzleConfig<TSchema>,
) => {
  const client = new Pool({
    connectionString,
  });

  return drizzle(client, config);
};

export const initDbWithOptions = <TSchema extends Record<string, unknown> = Record<string, never>>(
  poolConfig: PoolConfig,
  config: DrizzleConfig<TSchema>,
) => {
  const client = new Pool(poolConfig);

  return drizzle(client, config);
};

// Re-export factory functions
export { createDb, getDbConnectionOptions, getDbConnectionParams } from './factory';
