import { drizzle } from 'drizzle-orm/node-postgres';
import type { DrizzleConfig } from 'drizzle-orm/utils';
// import postgres from 'postgres';
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
