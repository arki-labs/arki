/**
 * `feature.instance('eu', rebind)` on the Redis lane: one declared feature, mounted twice.
 *
 * Why these tests exist: two copies of a feature share one `jobs(...)` declaration, so the
 * adapter must give each copy its own queue (`send-mail#eu`, `send-mail#us`) or one copy's
 * work runs with the other's services (the wrong region's database). The producer
 * (`jobProducers`) and the worker (`jobs(...)`) derive the name from the feature name, so they
 * cannot drift. A plain feature's names never change: live BullMQ queues, scheduler ids and
 * job ids must keep resolving after an upgrade.
 */
import type { StartedTestContainer } from 'testcontainers';
import { Queue } from 'bullmq';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { DotLifecycleErrorCode, plugin, rename, service } from '@arki/dot/plugin';

import type { FeatureJobContext, QueueClient } from './dot.ts';
import { jobProducers, jobs, queue, queueWorker } from './dot.ts';
import { initQueue } from './init.ts';
import { parseRedisConnection } from './redis-connection.ts';

let redisContainer: StartedTestContainer;
let redisUrl: string;

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  redisUrl = `redis://${redisContainer.getHost()}:${String(redisContainer.getMappedPort(6379))}`;
}, 60_000);

afterAll(async () => {
  await redisContainer.stop();
}, 30_000);

type Region = { readonly region: string };
const regionDb = (region: string) => plugin({ name: 'database', provides: { db: (): Region => ({ region }) } });
const database = regionDb('us');
const databaseEu = rename(regionDb('eu'), { db: 'dbEu' }, 'databaseEu');

/** What the feature's jobs see as `ctx.services`. */
type ReportServices = { readonly db: Region };
const q = initQueue.context<FeatureJobContext<ReportServices>>().create();

/** Every handler run, as `<region>:<job name>:<input>`. */
const ran: string[] = [];

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out; ran so far: ${JSON.stringify(ran)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function job(name: string) {
  return q.job
    .name(name)
    .input(z.object({ to: z.string() }))
    .handler((data, ctx) => {
      ran.push(`${ctx.services.db.region}:${ctx.job.name}:${data.to}`);
      return Promise.resolve({ ok: true });
    });
}

/** A feature with one job, its producer, a cron schedule and a one-off timeout schedule. */
function reportsFeature(name: string) {
  const sendMail = job(name);
  const nightly = q.schedule.cron('0 3 * * *').name(`${name}-nightly`).job(sendMail).data({ to: 'cron' });
  const once = q.schedule.timeout(3_600_000).name(`${name}-once`).job(sendMail).data({ to: 'later' });
  const reports = defineFeature('reports')
    .needs({ db: database.provides.db, queue: service<QueueClient>() })
    .infra(jobProducers({ sendMail }))
    .usecases({
      notify:
        ({ jobs: producers }) =>
        (to: string) =>
          producers.sendMail.enqueue({ to }),
    })
    .provides({ notifier: ({ usecases }) => usecases })
    .entrypoints(jobs(q.registry({ sendMail, nightly, once })));
  return { sendMail, reports };
}

function worker() {
  return queueWorker({ q: initQueue.create(), needs: {}, blocking: true, context: () => ({}) });
}

function bullQueue(name: string, keyPrefix: string): Queue {
  return new Queue(name, { connection: parseRedisConnection(redisUrl), prefix: keyPrefix });
}

describe('queueWorker + jobProducers: feature instances', () => {
  it('two instances get two queues; a usecase of the EU copy runs the EU job with the EU database only', async () => {
    const { reports } = reportsFeature('send-mail');
    const eu = reports.instance('eu', { db: databaseEu.provides.dbEu });
    const us = reports.instance('us');
    const keyPrefix = 'inst1:';
    ran.length = 0;

    const app = await defineApp('regions')
      .use(database)
      .use(databaseEu)
      .use(queue({ connection: redisUrl, keyPrefix }))
      .features([eu, us])
      .serve(worker())
      .start();
    try {
      const consumed = app.manifest.actions.filter(a => a.plugin === 'queue-worker').map(a => a.id);
      expect(consumed).toEqual(expect.arrayContaining(['send-mail#eu.consume', 'send-mail#us.consume']));
      expect(consumed).not.toContain('send-mail.consume');
      expect(app.manifest.actions.filter(a => a.binding === 'queue' && a.direction === 'out').map(a => a.id)).toEqual([
        'send-mail#eu.produce',
        'send-mail#us.produce',
      ]);
      expect(app.diagnostics.issues.filter(issue => issue.code === DotLifecycleErrorCode.DuplicateAction)).toEqual([]);

      await app.services['reports#eu.notifier'].notify('ada');
      await until(() => ran.length === 1);
      // Give a wrongly bound US worker the time to pick it up too.
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(ran).toEqual(['eu:send-mail#eu:ada']);

      await app.services['reports#us.notifier'].notify('bob');
      await until(() => ran.length === 2);
      expect(ran).toEqual(['eu:send-mail#eu:ada', 'us:send-mail#us:bob']);

      // Nothing was ever added under the plain name.
      const plain = bullQueue('send-mail', keyPrefix);
      expect(await plain.getJobCountByTypes('completed', 'waiting', 'active', 'delayed', 'failed')).toBe(0);
      await plain.close();
    } finally {
      await app.dispose();
    }
  });

  it("an instance's scheduler id and timeout job id carry its instance", async () => {
    const { reports } = reportsFeature('digest');
    const keyPrefix = 'inst2:';
    const app = await defineApp('regions-scheduled')
      .use(database)
      .use(databaseEu)
      .use(queue({ connection: redisUrl, keyPrefix }))
      .features([reports.instance('eu', { db: databaseEu.provides.dbEu })])
      .serve(worker())
      .start();
    const eu = bullQueue('digest#eu', keyPrefix);
    try {
      expect((await eu.getJobSchedulers()).map(s => s.key)).toEqual(['schedule:digest-nightly#eu']);
      expect((await eu.getJob('schedule-digest-once#eu'))?.name).toBe('digest#eu');
      expect(app.manifest.actions.filter(a => a.plugin === 'queue-worker').map(a => a.id)).toEqual([
        'digest#eu.consume',
        'digest-nightly#eu.fire',
        'digest-once#eu.fire',
      ]);
    } finally {
      await eu.close();
      await app.dispose();
    }
  });

  it("a plain feature's queue, scheduler id, job id and action ids are unchanged, and queue.enqueue(def) still runs", async () => {
    const { sendMail, reports } = reportsFeature('ledger');
    const keyPrefix = 'plain:';
    ran.length = 0;
    const app = await defineApp('plain')
      .use(database)
      .use(queue({ connection: redisUrl, keyPrefix }))
      .features([reports])
      .serve(worker())
      .start();
    const ledger = bullQueue('ledger', keyPrefix);
    try {
      expect((await ledger.getJobSchedulers()).map(s => s.key)).toEqual(['schedule:ledger-nightly']);
      expect((await ledger.getJob('schedule-ledger-once'))?.name).toBe('ledger');
      expect(app.manifest.actions.map(a => `${a.plugin}:${a.id}`)).toEqual([
        'reports:ledger.produce',
        'queue-worker:ledger.consume',
        'queue-worker:ledger-nightly.fire',
        'queue-worker:ledger-once.fire',
      ]);

      await app.services.notifier.notify('via-producer');
      await app.services.queue.enqueue(sendMail, { to: 'via-client' });
      await until(() => ran.length === 2);
      expect([...ran].sort()).toEqual(['us:ledger:via-client', 'us:ledger:via-producer']);
    } finally {
      await ledger.close();
      await app.dispose();
    }
  });

  it("types each producer's input from its job definition", () => {
    const sendMail = job('typed');
    defineFeature('typed')
      .needs({ queue: service<QueueClient>() })
      .infra(jobProducers({ sendMail }))
      .usecases({
        notify:
          ({ jobs: producers }) =>
          () => {
            expectTypeOf(producers.sendMail.enqueue).parameter(0).toEqualTypeOf<{ to: string }>();
            // @ts-expect-error -- `to` is a string
            return producers.sendMail.enqueue({ to: 1 });
          },
      });
    expect(true).toBe(true);
  });
});
