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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { PgPubSubPool } from './index.js';
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

describePubSubContract('pg on Postgres 17', () => {
  const pubsub = pgPubSub({ pool });
  // The contract listens on a working database, so a subscribe failure there is a bug: `orThrow` throws it.
  return Promise.resolve({
    pubsub: { ...pubsub, subscribe: (channel, onMessage) => orThrow(pubsub.subscribe(channel, onMessage)) },
    transaction: fn => db.transaction(fn),
  });
});

describe('pg subscribe when Postgres refuses the listener', () => {
  // Why: a subscriber must learn that it hears nothing (a typed failure it can act on), and the
  // failed channel must not stay cached, or every later subscribe would share the dead listen.
  it('resolves to db.listen_unavailable, keeps no channel, and tries again on the next subscribe', async () => {
    const refused = new URL(container.getConnectionUri());
    refused.password = 'wrong-password';
    const refusedPool = new pg.Pool({ connectionString: refused.toString(), max: 1 });
    refusedPool.on('error', () => null);
    let connects = 0;
    const counting: PgPubSubPool = {
      connect: () => {
        connects += 1;
        return refusedPool.connect();
      },
      query: (text, values) => refusedPool.query(text, values),
    };
    const pubsub = pgPubSub({ pool: counting });
    try {
      expect(await pubsub.subscribe('refused', () => null)).toMatchObject({ code: 'db.listen_unavailable' });
      expect(await pubsub.subscribe('refused', () => null)).toMatchObject({ code: 'db.listen_unavailable' });
      expect(connects).toBe(2);
    } finally {
      await pubsub.close();
      await refusedPool.end();
    }
  });
});
