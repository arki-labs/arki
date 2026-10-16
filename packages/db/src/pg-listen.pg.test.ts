/**
 * `listenOnPool` on a real Postgres (testcontainers), with the listener's pool
 * apart from the writer's.
 *
 * Why these tests exist: the scripted-pool tests prove the bookkeeping; only a
 * real server proves that `pg` really emits what the listener waits for. A
 * killed backend must surface as `disconnected` and come back as `ready` on a
 * new client, a pool with no free client must not lose the listener for good,
 * and stop must leave the pool with nothing checked out and nothing reusable
 * that still carries our handlers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listenOnPool } from './pg-listen.js';

let container: StartedPostgreSqlContainer;
let writer: pg.Pool;
const pools: pg.Pool[] = [];

/** One client at most; its backends are named `name`, so a test can kill them. */
function listenPool(name: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 1, application_name: name });
  pool.on('error', () => null);
  pools.push(pool);
  return pool;
}

const notify = (channel: string, payload: string) => writer.query('select pg_notify($1, $2)', [channel, payload]);
const kill = (name: string) =>
  writer.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [name]);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  writer = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
}, 120_000);

afterAll(async () => {
  await Promise.all([writer, ...pools].map(pool => pool.end()));
  await container.stop();
});

describe('listenOnPool on Postgres 16', () => {
  it('hears commits from another connection, and a killed backend reports disconnected, then ready on a new client', async () => {
    const pool = listenPool('listener_a');
    const states: string[] = [];
    const seen: string[] = [];
    const stop = await listenOnPool(pool, 'live_a', { retryMs: 50, onState: state => states.push(state) })(payload =>
      seen.push(payload),
    );
    try {
      expect(states).toEqual(['ready']);
      await notify('live_a', 'one');
      await expect.poll(() => seen).toEqual(['one']);

      await kill('listener_a');
      await expect.poll(() => states).toEqual(['ready', 'disconnected', 'ready']);
      await notify('live_a', 'two');
      await expect.poll(() => seen).toEqual(['one', 'two']);
    } finally {
      await stop();
    }
    // Closed on stop, not returned: nothing checked out, and no idle client with our handlers on it.
    expect(pool.totalCount).toBe(0);
  });

  it('waits out a pool with no free client and listens again once one is released', async () => {
    const pool = listenPool('listener_b');
    const states: string[] = [];
    const seen: string[] = [];
    const stop = await listenOnPool(pool, 'live_b', { retryMs: 50, onState: state => states.push(state) })(payload =>
      seen.push(payload),
    );
    try {
      await kill('listener_b');
      await expect.poll(() => states).toEqual(['ready', 'disconnected']);
      // Another user takes the pool's only client before the listener retries.
      const borrowed = await pool.connect();
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(states).toEqual(['ready', 'disconnected']);
      borrowed.release();
      await expect.poll(() => states).toEqual(['ready', 'disconnected', 'ready']);
      await notify('live_b', 'back');
      await expect.poll(() => seen).toEqual(['back']);
    } finally {
      await stop();
    }
    expect(pool.totalCount - pool.idleCount, 'no client still checked out').toBe(0);
  });

  it('health checks on a live connection never drop it, while notifications keep arriving', async () => {
    const pool = listenPool('listener_c');
    const states: string[] = [];
    const seen: string[] = [];
    const stop = await listenOnPool(pool, 'live_c', { healthMs: 50, onState: state => states.push(state) })(payload =>
      seen.push(payload),
    );
    try {
      for (let round = 0; round < 10; round += 1) {
        await notify('live_c', String(round));
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      await expect.poll(() => seen.length).toBe(10);
      expect(states).toEqual(['ready']);
    } finally {
      await stop();
    }
  });
});
