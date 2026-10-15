/**
 * Advisory locks across two "replicas" (two pools on one real Postgres, in a
 * container). This is the guarantee schedules rely on: while one replica runs
 * a job, the other skips it — for as long as the job runs, however long that is.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { advisoryLocks } from './lock.js';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let replicaA: NodePgDatabase;
let replicaB: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  replicaA = drizzle({ client: poolA });
  replicaB = drizzle({ client: poolB });
}, 120_000);

afterAll(async () => {
  await Promise.all([poolA?.end(), poolB?.end()]);
  await container?.stop();
});

const advisoryCount = async (db: NodePgDatabase): Promise<number> => {
  const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
  return result.rows[0]?.n ?? -1;
};

describe('advisory locks across replicas', () => {
  it('the second replica skips while the first runs, and runs once the first is done', async () => {
    const locksA = advisoryLocks(replicaA, { namespace: 'app' });
    const locksB = advisoryLocks(replicaB, { namespace: 'app' });

    const { promise: blocker, resolve: finish } = Promise.withResolvers<void>();
    const { promise: running, resolve: started } = Promise.withResolvers<void>();

    const first = locksA.tryRun('digest', async () => {
      started();
      // The job may use its own pool while the pinned connection holds the lock.
      const held = await advisoryCount(replicaA);
      await blocker;
      return held;
    });
    await running;

    expect(await locksB.tryRun('digest', async () => 'should not run')).toEqual({ ran: false });
    // Another key is a different lock: it runs.
    expect(await locksB.tryRun('other-job', async () => 'ran')).toEqual({ ran: true, value: 'ran' });

    finish();
    expect(await first).toEqual({ ran: true, value: 1 });
    expect(await advisoryCount(replicaB)).toBe(0);
    expect(await locksB.tryRun('digest', async () => 'now me')).toEqual({ ran: true, value: 'now me' });
  });

  it('namespaces keep two apps on one server apart', async () => {
    const { promise: blocker, resolve: finish } = Promise.withResolvers<void>();
    const avocabo = advisoryLocks(replicaA, { namespace: 'avocabo' }).tryRun('digest', () => blocker);
    expect(await advisoryLocks(replicaB, { namespace: 'novelette' }).tryRun('digest', async () => 'ran')).toEqual({
      ran: true,
      value: 'ran',
    });
    finish();
    await avocabo;
  });
});
