/**
 * T(queue-client-split): an API process enqueues with `queue()`, a separate
 * worker process runs the job with `queueWorker()` (real Redis).
 * Why it matters: the API server never registers jobs, so the job's own
 * `trigger()` cannot work there. The client must reach the SAME BullMQ queue
 * the worker reads, with the SAME retry defaults the job declares.
 */
import type { StartedTestContainer } from 'testcontainers';
import { Queue } from 'bullmq';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable, z } from '@arki/contracts';
import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { orThrow, UnexpectedDefect } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { jobs, queue, queueWorker } from './dot.ts';
import { initQueue } from './init.ts';
import { createQueueClient } from './queue-client.ts';
import { parseRedisConnection } from './redis-connection.ts';

let redisContainer: StartedTestContainer;
let redisUrl: string;

beforeAll(async () => {
  redisContainer = await orThrow(
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  );
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
}, 60_000);

afterAll(async () => {
  await redisContainer.stop();
}, 30_000);

async function waitFor(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting');
}

describe('queue() client + queueWorker() in separate apps', () => {
  it('does not open a producer queue on entropy failure and honors the effective explicit BullMQ key', async () => {
    const q = initQueue.context<Record<string, never>>().create();
    const job = q.job
      .name(`client-entropy-${crypto.randomUUID()}`)
      .input(z.object({ n: z.number() }))
      .handler(() => Promise.resolve('done'));
    const handle = createQueueClient({ connection: redisUrl, keyPrefix: `entropy-${crypto.randomUUID()}` });
    const add = vi.spyOn(Queue.prototype, 'add');
    const close = vi.spyOn(Queue.prototype, 'close');
    try {
      vi.stubGlobal('crypto', null);
      expect(await handle.client.enqueue(job, { n: 1 })).toMatchObject({ code: RandomSourceUnavailable.code });
      expect(add).not.toHaveBeenCalled();
      vi.stubGlobal('crypto', {
        randomUUID: () => {
          throw new Error('entropy');
        },
      });
      expect(await handle.client.enqueue(job, { n: 1 })).toMatchObject({ code: UnexpectedDefect.code });
      expect(add).not.toHaveBeenCalled();
      await handle.close();
      expect(close).not.toHaveBeenCalled();
      expect(
        orThrow(await handle.client.enqueue(job, { n: 1 }, { jobId: 'outer', bullmqOptions: { jobId: 'nested' } })),
      ).toBe('nested');
      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      add.mockRestore();
      await handle.close();
      close.mockRestore();
    }
  });

  it('a job enqueued by the API app runs in the worker app, with the job retry defaults', async () => {
    const q = initQueue.context<{ readonly worker: string }>().create();
    const received: string[] = [];
    const sendMail = q.job
      .name(`send-mail-${crypto.randomUUID()}`)
      .input(z.object({ to: z.string() }))
      .options({ retry: backoff.exponential({ base: 1000 }).upTo(4) })
      .handler((data, ctx) => {
        received.push(`${ctx.worker}:${data.to}`);
        return Promise.resolve('sent');
      });
    const mail = defineFeature('mail').entrypoints(jobs({ sendMail }));
    const keyPrefix = `split-${crypto.randomUUID()}:`;

    const api = await orThrow(
      defineApp('api')
        .infra(queue({ connection: redisUrl, keyPrefix }))
        .features([mail])
        .start(),
    );
    const worker = await orThrow(
      defineApp('worker')
        .infra(queue({ connection: redisUrl, keyPrefix }))
        .features([mail])
        .entrypoints(queueWorker({ q, needs: {}, blocking: true, context: () => ({ worker: 'w1' }) }))
        .start(),
    );

    try {
      const jobId = await api.services.queue.enqueue(sendMail, { to: 'a@b.c' });
      await waitFor(() => received.length === 1);
      expect(received).toEqual(['w1:a@b.c']);
      // An API retry can reuse the returned generated key rather than enqueue the effect twice.
      expect(orThrow(await api.services.queue.enqueue(sendMail, { to: 'a@b.c' }, { jobId: orThrow(jobId) }))).toBe(
        orThrow(jobId),
      );
      await new Promise(resolve => setTimeout(resolve, 650));
      expect(received).toEqual(['w1:a@b.c']);

      const inspect = new Queue(sendMail._internal.name, {
        connection: parseRedisConnection(redisUrl),
        prefix: keyPrefix,
      });
      try {
        const job = await inspect.getJob(orThrow(jobId));
        expect(job?.opts.attempts).toBe(5);
        expect(await inspect.getJobCounts()).toMatchObject({ completed: 1 });
      } finally {
        await inspect.close();
      }
    } finally {
      await worker.dispose();
      await api.dispose();
    }
  }, 30_000);
  // Why: a flow is a BullMQ tree, so a parent step must run only after its
  // child finished. Before flows were wired, enqueue had no flow path at all
  // and nothing ever ran.
  it('a flow started by the API app runs in the worker app, the child step before its parent', async () => {
    const q = initQueue.context<{ readonly worker: string }>().create();
    const finished: string[] = [];
    const reserve = q.job
      .name(`reserve-${crypto.randomUUID()}`)
      .input(z.object({ orderId: z.string() }))
      .handler(async data => {
        // Slow child: a parent that did not wait would finish first
        await new Promise(resolve => setTimeout(resolve, 200));
        finished.push(`reserve:${data.orderId}`);
        return 'reserved';
      });
    const notify = q.job
      .name(`notify-${crypto.randomUUID()}`)
      .input(z.object({ to: z.string() }))
      .handler((data, ctx) => {
        finished.push(`notify:${data.to}:${ctx.worker}`);
        return Promise.resolve('sent');
      });
    const orderFlow = q.flow
      .name('orders.process')
      .input(z.object({ orderId: z.string() }))
      .step('reserve', { job: reserve, data: input => ({ orderId: input.orderId }) })
      .step('notify', { job: notify, data: input => ({ to: input.orderId }), dependsOn: ['reserve'] })
      .build();
    const orders = defineFeature('orders').entrypoints(jobs({ reserve, notify, orderFlow }));
    const keyPrefix = `flow-${crypto.randomUUID()}:`;

    const api = await orThrow(
      defineApp('api')
        .infra(queue({ connection: redisUrl, keyPrefix }))
        .features([orders])
        .start(),
    );
    const worker = await orThrow(
      defineApp('worker')
        .infra(queue({ connection: redisUrl, keyPrefix }))
        .features([orders])
        .entrypoints(queueWorker({ q, needs: {}, blocking: true, context: () => ({ worker: 'w1' }) }))
        .start(),
    );

    try {
      const started = orThrow(await api.services.queue.enqueue(orderFlow, { orderId: 'o-1' }));
      expect(started.flow).toBe('orders.process');
      expect(Object.keys(started.jobIds).toSorted()).toEqual(['notify', 'reserve']);

      await waitFor(() => finished.length === 2);
      expect(finished).toEqual(['reserve:o-1', 'notify:o-1:w1']);
    } finally {
      await worker.dispose();
      await api.dispose();
    }
  }, 30_000);
});
