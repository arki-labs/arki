/**
 * Locked schedules on a real Postgres lease store, three replicas (three Dot apps, three pools).
 *
 * Why: the memory-store tests prove the schedule's rules, but a cron job runs on every replica
 * of a deployment. Only a shared store makes "runs once" true, and only a real database shows
 * that the lease is taken once, kept alive past its TTL while the job works, handed over when
 * its holder stops renewing, and that the old holder is told to stop.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DotApp } from '@arki/dot';
import type { Failure } from '@arki/failure';
import { defineFeature } from '@arki/dot/feature';
import { defineApp, infra } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { createLocks } from '@arki/lock';
import { ensureLockTable, pgLease } from '@arki/lock/pg/lease';

import type { ScheduleRun } from './index.js';
import { schedule, schedules } from './dot.js';

const TABLE = 'arki_schedule_lock_test';
const TTL = '2s';

// Undefined when startup failed: then afterAll must not hide that error behind its own.
let container: StartedPostgreSqlContainer | undefined;
const pools: pg.Pool[] = [];
const running: Pick<DotApp<Record<string, never>, Failure>, 'dispose'>[] = [];

beforeAll(async () => {
  const started = await new PostgreSqlContainer('postgres:17-alpine').start();
  container = started;
  const setup = new pg.Pool({ connectionString: started.getConnectionUri(), max: 1 });
  pools.push(setup);
  await ensureLockTable(drizzle({ client: setup }), TABLE);
}, 120_000);

afterEach(async () => {
  await Promise.all(running.splice(0).map(app => orThrow(app.dispose())));
  await pools[0]?.query(`DELETE FROM ${TABLE}`);
});

afterAll(async () => {
  await Promise.all(pools.map(pool => pool.end()));
  await container?.stop();
});

type Work = (replica: string, run: ScheduleRun) => Promise<string>;

/** One replica: its own pool, its own lease store, the same schedule and lock key as the others. */
async function replica(name: string, work: Work) {
  if (container === undefined) throw new Error('the Postgres container did not start');
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  pools.push(pool);
  const db: NodePgDatabase = drizzle({ client: pool });
  const lockService = createLocks({ store: pgLease(db, { ttl: TTL, table: TABLE }), namespace: 'cluster' });
  const core = defineFeature('reports').infra(infra({ name: 'locks', provides: { locks: () => lockService } }));
  const reports = core.entrypoints(
    schedules(core, [
      { name: 'nightly-report', cron: '0 3 * * *', lock: { holdAtLeast: 0 }, handler: (_deps, run) => work(name, run) },
    ]),
  );
  const started = await orThrow(
    defineApp(`reports-${name}`)
      .features([reports])
      .entrypoints(schedule({ clock: 'host' }))
      .start(),
  );
  running.push(started);
  return { name, trigger: () => started.services.scheduler.trigger('nightly-report') };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { open, opened };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('a locked schedule on three replicas, real Postgres', () => {
  it('the same tick on all three runs once; the other two skip on the held lock', async () => {
    const release = gate();
    const ran: string[] = [];
    const work: Work = async name => {
      ran.push(name);
      await release.opened;
      return name;
    };
    const replicas = await Promise.all(['a', 'b', 'c'].map(name => replica(name, work)));
    const ticks = replicas.map(each => each.trigger());
    await vi.waitFor(() => expect(ran).toHaveLength(1));
    release.open();
    const outcomes = await Promise.all(ticks);
    expect(outcomes.map(outcome => outcome.status).toSorted()).toEqual(['ran', 'skipped-lock', 'skipped-lock']);
    expect(ran).toHaveLength(1);
  }, 30_000);

  it('a run longer than the TTL keeps the key: the holder renews it, so a later tick still skips', async () => {
    const release = gate();
    const work: Work = async name => {
      if (name === 'a') await release.opened;
      return name;
    };
    const [a, b] = await Promise.all([replica('a', work), replica('b', work)]);
    const first = a.trigger();
    await sleep(3000); // longer than the 2 s TTL: only renewals keep the lease
    await expect(b.trigger()).resolves.toMatchObject({ status: 'skipped-lock' });
    release.open();
    await expect(first).resolves.toMatchObject({ status: 'ran', value: 'a' });
  }, 30_000);

  it('when the holder stops renewing, the lease expires, another replica takes over with a higher fence, and the old run is told to stop', async () => {
    let holder: ScheduleRun | undefined;
    let takeover: ScheduleRun | undefined;
    const release = gate();
    const work: Work = async (name, run) => {
      if (name === 'a') {
        holder = run;
        await release.opened;
      } else {
        takeover = run;
      }
      return name;
    };
    const [a, b] = await Promise.all([replica('a', work), replica('b', work)]);
    const first = a.trigger();
    await vi.waitFor(() => expect(holder).toBeDefined());

    // As if replica a had paused past its TTL: its lease is old on the database clock.
    await pools[0]?.query(`UPDATE ${TABLE} SET expires_at = now() - interval '1 second'`);
    await expect(b.trigger()).resolves.toMatchObject({ status: 'ran', value: 'b' });

    // a's next renewal finds the key gone, and its run's signal aborts so the job can stop.
    await vi.waitFor(() => expect(holder?.lock?.signal.aborted).toBe(true), { timeout: 5000 });
    const oldFence = holder?.lock?.fence;
    const newFence = takeover?.lock?.fence;
    if (oldFence === undefined || newFence === undefined) throw new Error('pgLease hands out fences');
    expect(newFence).toBeGreaterThan(oldFence);
    release.open();
    await first;
  }, 30_000);

  it('once the holder finishes, the next tick on any replica runs again', async () => {
    const work: Work = name => Promise.resolve(name);
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(name => replica(name, work)));
    await expect(a?.trigger()).resolves.toMatchObject({ status: 'ran', value: 'a' });
    await expect(b?.trigger()).resolves.toMatchObject({ status: 'ran', value: 'b' });
    await expect(c?.trigger()).resolves.toMatchObject({ status: 'ran', value: 'c' });
  }, 30_000);
});
