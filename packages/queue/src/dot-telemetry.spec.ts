/**
 * Inside a Dot app, a job enqueued by a usecase opens `queue.enqueue` under the
 * usecase's span. So a trace shows which usecase enqueued the job. Real Redis
 * (a container), real BullMQ, and a real worker that runs the job.
 */
import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import { jobs, queue, queueWorker } from './dot.ts';
import { initQueue } from './init.ts';

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

describe('@arki/queue spans inside a Dot app', () => {
  it('nests queue.enqueue under the Dot usecase span, so a trace shows which usecase enqueued the job', async () => {
    using spans = captureSpans();
    const q = initQueue.create();
    const received: string[] = [];
    const confirm = q.job
      .name(`confirm-${crypto.randomUUID()}`)
      .input(z.object({ orderId: z.string() }))
      .handler(data => {
        received.push(data.orderId);
        return Promise.resolve('confirmed');
      });
    const producer = queue({
      connection: redisUrl,
      keyPrefix: `telemetry-${crypto.randomUUID()}:`,
    });
    const orders = defineFeature('orders')
      .needs({ queue: producer.provides.queue })
      .usecases({
        place:
          ({ queue: client }) =>
          (orderId: string) =>
            client.enqueue(confirm, { orderId }),
      })
      .entrypoints(jobs({ confirm }));

    const app = orThrow(
      await defineApp('queue-telemetry')
        .infra(producer)
        .features([orders])
        .entrypoints(queueWorker({ q, needs: {}, blocking: true, context: () => ({}) }))
        .start(),
    );
    try {
      orThrow(await app.services['orders.usecases'].place('o-1'));
      await waitFor(() => received.length === 1);
    } finally {
      orThrow(await app.dispose());
    }

    expect(received).toEqual(['o-1']);
    expect(spans.named('queue.enqueue').parent).toBe(spans.named('feature.orders.place'));
  }, 30_000);
});
