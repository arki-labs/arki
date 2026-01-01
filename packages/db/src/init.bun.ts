import type { DrizzleConfig } from 'drizzle-orm/utils';
import { drizzle } from 'drizzle-orm/bun-sql';
import { SQL } from 'bun';

import { debugInit } from './debug';

// Use Bun's native SQL for PostgreSQL (much faster than pg)
debugInit('[init.bun] Using Bun SQL (native) for database connections');

export const initDb = <TSchema extends Record<string, unknown> = Record<string, never>>(
  connectionString: string,
  config: DrizzleConfig<TSchema>,
) => {
  debugInit('[init.bun] Initializing database with connection string (logger: %s)', !!config.logger);

  const client = new SQL(connectionString);
  const db = drizzle({ client, ...config });

  debugInit('[init.bun] Database initialized successfully');

  return db;
};

export const initDbWithOptions = <TSchema extends Record<string, unknown> = Record<string, never>>(
  poolConfig: {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    min?: number;
    max?: number;
  },
  config: DrizzleConfig<TSchema>,
) => {
  debugInit('[init.bun] Initializing database with pool config (min: %d, max: %d, logger: %s)',
    poolConfig.min ?? 0, poolConfig.max ?? 10, !!config.logger);

  // Bun SQL accepts either a connection string or individual options
  const client = poolConfig.connectionString
    ? new SQL(poolConfig.connectionString)
    : new SQL({
        hostname: poolConfig.host,
        port: poolConfig.port,
        database: poolConfig.database,
        username: poolConfig.user,
        password: poolConfig.password,
      });

  const db = drizzle({ client, ...config });

  debugInit('[init.bun] Database initialized with custom pool configuration');

  return db;
};

// Re-export factory and connection utilities
export { createDb } from './factory';
export { getDbConnectionOptions, getDbConnectionParams } from './connection-options';
