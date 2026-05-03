import type { AnyRelations } from 'drizzle-orm';
import type { DrizzlePgConfig } from 'drizzle-orm/pg-core/utils';
import type { PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { debugInit } from './debug';

const isBun = 'Bun' in globalThis;

const Pool = isBun ? pg.Pool : (pg.native?.Pool ?? pg.Pool);
debugInit('[init] Using %s for database connections', isBun ? 'pg (pure JS - Bun detected)' : 'pg-native');

export const initDb = <TRelations extends AnyRelations>(
  connectionString: string,
  config: Omit<DrizzlePgConfig<TRelations>, 'relations'> & { relations: TRelations },
) => {
  debugInit('[init] Initializing database with connection string (logger: %s)', !!config.logger);

  const client = new Pool({
    connectionString,
  });

  const db = drizzle<TRelations>({ ...config, client });
  debugInit('[init] Database initialized successfully');

  return db;
};

export const initDbWithOptions = <TRelations extends AnyRelations>(
  poolConfig: PoolConfig,
  config: Omit<DrizzlePgConfig<TRelations>, 'relations'> & { relations: TRelations },
) => {
  debugInit(
    '[init] Initializing database with pool config (min: %d, max: %d, logger: %s)',
    poolConfig.min ?? 0,
    poolConfig.max ?? 10,
    !!config.logger,
  );

  const client = new Pool(poolConfig);

  const db = drizzle<TRelations>({ ...config, client });
  debugInit('[init] Database initialized with custom pool configuration');

  return db;
};

export { createDb } from './factory';
export { getDbConnectionOptions, getDbConnectionParams } from './connection-options';
