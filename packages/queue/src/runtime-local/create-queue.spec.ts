/**
 * The runtime-local (pg-boss on PGlite) queue follows the BullMQ rules:
 * a schedule sends to its job's own queue (keyed by the schedule name, so
 * several schedules fit one job), an inline schedule runs as a job with its
 * `.use()` middleware, and middleware wraps the handler (onion).
 *
 * pg-boss fires cron schedules at minute granularity, too slow for a test.
 * A tick is `boss.send(jobName, data)`, which is what `job.trigger(data)`
 * does, so the tests read the stored schedule rows and trigger the job.
 */

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import { QUEUE_DEFINITION_ERROR_CODES } from '../errors.ts';
import type { InternalScheduleDefinition } from '../schedule-builder.ts';
import type { QueueInstance } from '../types/builder.ts';
import { createRuntimeLocalQueueInstance, initQueue } from './index.ts';

type TestContext = { userId: string };

const SCHEMA = 'infra_pg_boss';

let pglite: PGlite;
let queue: QueueInstance | undefined;

beforeEach(() => {
  pglite = new PGlite();
});

afterEach(async () => {
  await queue?.stop();
  queue = undefined;
  await pglite.close();
});

function startQueue(registry: Record<string, unknown>): Promise<void> {
  const instance = createRuntimeLocalQueueInstance<TestContext>({
    pglite,
    createContext: () => ({ userId: 'local-user' }),
  });
  queue = instance;
  return instance.register(registry).then(() => instance.start());
}

/** Wait until `done()` holds; the local workers poll every 500ms. */
async function waitFor(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (done()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the job to run');
}

async function scheduleRows(): Promise<{ name: string; key: string; data: unknown }[]> {
  const result = await pglite.query<{ name: string; key: string; data: unknown }>(
    `select name, key, data from ${SCHEMA}.schedule order by key`,
  );
  return result.rows;
}

describe('runtime-local schedules trigger their job', () => {
  it("sends to the job's own queue, one keyed entry per schedule, and runs the job's middleware", async () => {
    const q = initQueue.context<TestContext>().create();
    const order: string[] = [];

    const tracing = q.middleware(async ({ next }) => {
      order.push('job-mw-before');
      try {
        return await next();
      } finally {
        order.push('job-mw-after');
      }
    });

    const job = q.job
      .use(tracing)
      .name('local-shared')
      .input(z.object({ slot: z.string() }))
      .handler(async data => {
        order.push(`handler-${data.slot}`);
      });

    // Only the schedules are registered: they must register the job and its worker.
    const morning = q.schedule.cron('0 8 * * *').name('local-morning').job(job).data({ slot: 'am' });
    const evening = q.schedule.cron('0 20 * * *').name('local-evening').job(job).data({ slot: 'pm' });

    await startQueue(q.registry({ morning, evening }));

    expect(await scheduleRows()).toEqual([
      { name: 'local-shared', key: 'local-evening', data: { slot: 'pm' } },
      { name: 'local-shared', key: 'local-morning', data: { slot: 'am' } },
    ]);

    // A tick sends the schedule data to the job's queue, exactly like trigger().
    await job.trigger({ slot: 'am' });
    await waitFor(() => order.length === 3);

    expect(order).toEqual(['job-mw-before', 'handler-am', 'job-mw-after']);
  }, 15000);

  it('runs an inline schedule as a job, with its .use() middleware around the handler', async () => {
    const q = initQueue.context<TestContext>().create();
    const order: string[] = [];

    const tracing = q.middleware(async ({ next }) => {
      order.push('schedule-mw-before');
      try {
        return await next();
      } finally {
        order.push('schedule-mw-after');
      }
    });

    const schedule = q.schedule
      .cron('0 * * * *')
      .use(tracing)
      .name('local-inline')
      .input(z.object({}))
      .handler(async (_data, ctx) => {
        // Yield first: an `after` that ran before the handler finished would land here.
        await new Promise(resolve => setTimeout(resolve, 50));
        order.push(`handler-${ctx.userId}`);
      });

    await startQueue(q.registry({ schedule }));

    expect(await scheduleRows()).toEqual([{ name: 'local-inline', key: 'local-inline', data: {} }]);

    const internal = schedule._internal as InternalScheduleDefinition;
    await internal.job.trigger({});
    await waitFor(() => order.length === 3);

    expect(order).toEqual(['schedule-mw-before', 'handler-local-user', 'schedule-mw-after']);
  }, 15000);

  it('prunes a keyed schedule removed from code at start, and leaves unkeyed entries', async () => {
    const build = () => {
      const q = initQueue.context<TestContext>().create();
      const job = q.job
        .name('local-pruned')
        .input(z.object({ slot: z.string() }))
        .handler(async () => {});
      return { q, job };
    };

    // First deploy: schedules A and B on one job.
    const before = build();
    const a = before.q.schedule.cron('0 8 * * *').name('local-a').job(before.job).data({ slot: 'am' });
    const b = before.q.schedule.cron('0 20 * * *').name('local-b').job(before.job).data({ slot: 'pm' });
    await startQueue(before.q.registry({ a, b }));
    await queue?.stop();

    // An unkeyed schedule on the same queue (the app's own, or one an older version left): not ours.
    await pglite.query(
      `insert into ${SCHEMA}.schedule (name, key, kind, cron, timezone, data, options) values ($1, '', 'cron', '0 1 * * *', 'UTC', '{}', '{}')`,
      ['local-pruned'],
    );

    // Next deploy on the same database (a restart): B was deleted from code.
    const after = build();
    const aAgain = after.q.schedule.cron('0 8 * * *').name('local-a').job(after.job).data({ slot: 'am' });
    await startQueue(after.q.registry({ aAgain }));

    expect((await scheduleRows()).map(row => row.key)).toEqual(['', 'local-a']);
  }, 15000);

  it('throws a coded error for a duplicate schedule name', async () => {
    const q = initQueue.context<TestContext>().create();

    const job = q.job
      .name('local-dupe')
      .input(z.object({}))
      .handler(async () => {});

    const first = q.schedule.cron('0 1 * * *').name('local-dupe-name').job(job).data({});
    const second = q.schedule.cron('0 2 * * *').name('local-dupe-name').job(job).data({});

    await expect(startQueue(q.registry({ first, second }))).rejects.toMatchObject({
      name: 'QueueDefinitionError',
      code: QUEUE_DEFINITION_ERROR_CODES.duplicateScheduleName,
    });
  });
});
