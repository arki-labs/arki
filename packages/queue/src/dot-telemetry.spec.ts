/**
 * Inside a Dot app, a job enqueued by a usecase opens `queue.enqueue` under the
 * usecase's span. So a trace shows which usecase enqueued the job. The worker's
 * `queue.execute` continues that trace when the message carries it, and starts
 * a new one when it does not: never under the app's startup span. Real Redis
 * (a container), real BullMQ, and a real worker that runs the job.
 */
import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import type { TextMapPropagator } from '@opentelemetry/api';
import { propagation, SpanKind, trace } from '@opentelemetry/api';
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

/**
 * A W3C `traceparent` propagator. `captureSpans()` registers none, and the producer's trace reaches the
 * worker only through one. Written here because `@opentelemetry/core` is not a dependency of this package.
 */
const traceparent: TextMapPropagator = {
  inject(current, carrier, setter) {
    const span = trace.getSpanContext(current);
    if (span !== undefined)
      setter.set(carrier, 'traceparent', `00-${span.traceId}-${span.spanId}-0${span.traceFlags.toString(16)}`);
  },
  extract(current, carrier, getter) {
    const header = getter.get(carrier, 'traceparent');
    const [, traceId, spanId, flags] =
      /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(header)) ?? [];
    if (traceId === undefined || spanId === undefined || flags === undefined) return current;
    return trace.setSpanContext(current, { traceId, spanId, traceFlags: Number.parseInt(flags, 16), isRemote: true });
  },
  fields: () => ['traceparent'],
};

async function waitFor(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting');
}

/** Starts a Dot app whose usecase enqueues one job, waits for the worker to run it after boot, then disposes it. */
async function runOneJob(): Promise<string[]> {
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
  return received;
}

describe('@arki/queue spans inside a Dot app', () => {
  it('nests queue.enqueue under the Dot usecase span, so a trace shows which usecase enqueued the job', async () => {
    using spans = captureSpans();
    expect(await runOneJob()).toEqual(['o-1']);
    expect(spans.named('queue.enqueue').parent).toBe(spans.named('feature.orders.place'));
  }, 30_000);

  it('starts a new trace for a job that carries none, so a background job never appears as part of app startup', async () => {
    // No propagator: the message carries no trace, as in an app that configures none.
    using spans = captureSpans();
    expect(await runOneJob()).toEqual(['o-1']);

    const execute = spans.named('queue.execute');
    const startup = spans.finished.filter(span => span.name === 'dot.unit.start');
    expect(startup.length).toBeGreaterThan(0);
    // A root span in a trace of its own: not under the ended `dot.unit.start` span, nor in its trace.
    expect(execute.parentSpanContext).toBeUndefined();
    for (const span of startup) expect(execute.spanContext().traceId).not.toBe(span.spanContext().traceId);
    expect(execute.kind).toBe(SpanKind.CONSUMER);
  }, 30_000);

  it('continues the producer trace when the message carries one, so a trace runs from the usecase to the job', async () => {
    using spans = captureSpans();
    propagation.setGlobalPropagator(traceparent);
    try {
      expect(await runOneJob()).toEqual(['o-1']);
    } finally {
      propagation.disable();
    }

    const enqueue = spans.named('queue.enqueue');
    expect(enqueue.kind).toBe(SpanKind.PRODUCER);
    expect(spans.named('queue.execute').parent).toBe(enqueue);
    expect(spans.named('queue.execute').kind).toBe(SpanKind.CONSUMER);
  }, 30_000);
});
