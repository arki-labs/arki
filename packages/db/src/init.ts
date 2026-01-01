import type { DrizzleConfig } from 'drizzle-orm/utils';
import type { PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { debugInit } from './debug';

// Detect if running in Bun - skip native bindings (incompatible ABI)
// Note: When running in Bun, the conditional export in package.json should route
// to init.bun.ts. This fallback handles cases where conditional exports aren't resolved.
const isBun = 'Bun' in globalThis;

// Use native bindings only in Node.js for better performance
// In Bun, use pure JS pg (pg-native uses Node.js native addons incompatible with Bun)
const Pool = isBun ? pg.Pool : (pg.native?.Pool ?? pg.Pool);
debugInit('[init] Using %s for database connections', isBun ? 'pg (pure JS - Bun detected)' : 'pg-native');

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
  debugInit(
    '[init] Initializing database with pool config (min: %d, max: %d, logger: %s)',
    poolConfig.min ?? 0,
    poolConfig.max ?? 10,
    !!config.logger,
  );

  const client = new Pool(poolConfig);

  const db = drizzle(client, config);
  debugInit('[init] Database initialized with custom pool configuration');

  return db;
};

// Re-export factory and connection utilities
export { createDb } from './factory';
export { getDbConnectionOptions, getDbConnectionParams } from './connection-options';
