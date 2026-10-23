/**
 * The pg backend against a real Postgres (container): LISTEN/NOTIFY needs
 * separate connections, which PGlite does not have. `bun run test:pg`; fails
 * without Docker.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { describePubSubContract } from '../testing/index.js';
import { pgPubSub } from './index.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 20 });
  db = drizzle({ client: pool });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describePubSubContract('pg on Postgres 17', () =>
  Promise.resolve({ pubsub: pgPubSub({ pool }), transaction: fn => db.transaction(fn) }),
);
