import type { AnyRelations } from 'drizzle-orm';
import type { DrizzlePgConfig } from 'drizzle-orm/pg-core/utils';
import { drizzle } from 'drizzle-orm/bun-sql/postgres';
import { SQL } from 'bun';

import { debugInit } from './debug.js';

debugInit('[init.bun] Using Bun SQL (native) for database connections');

export const initDb = <TRelations extends AnyRelations>(
  connectionString: string,
  config: Omit<DrizzlePgConfig<TRelations>, 'relations'> & { relations: TRelations },
) => {
  debugInit('[init.bun] Initializing database with connection string (logger: %s)', !!config.logger);

  const client = new SQL(connectionString);
  const db = drizzle<TRelations>({ ...config, client });

  debugInit('[init.bun] Database initialized successfully');

  return db;
};

export const initDbWithOptions = <TRelations extends AnyRelations>(
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
  config: Omit<DrizzlePgConfig<TRelations>, 'relations'> & { relations: TRelations },
) => {
  debugInit('[init.bun] Initializing database with pool config (min: %d, max: %d, logger: %s)',
    poolConfig.min ?? 0, poolConfig.max ?? 10, !!config.logger);

  const client = poolConfig.connectionString
    ? new SQL(poolConfig.connectionString)
    : new SQL({
        hostname: poolConfig.host,
        port: poolConfig.port,
        database: poolConfig.database,
        username: poolConfig.user,
        password: poolConfig.password,
      });

  const db = drizzle<TRelations>({ ...config, client });

  debugInit('[init.bun] Database initialized with custom pool configuration');

  return db;
};

export { createDb } from './factory.js';
export { getDbConnectionOptions, getDbConnectionParams } from './connection-options.js';
