/**
 * On a real Redis 7 (container; `bun run test:redis`): `PUBLISH` and each delivery are spanned,
 * with the backend as the only attribute.
 */
import type { StartedTestContainer } from 'testcontainers';
import { SpanStatusCode } from '@opentelemetry/api';
import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { captureSpans } from '@arki/testing/otel';

import { redisPubSub } from './index.js';

let container: StartedTestContainer;
let client: Redis;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  client = new Redis(container.getMappedPort(6379), container.getHost());
});

afterAll(async () => {
  await client.quit();
  await container.stop();
});

it('spans the publish and the delivery, and records neither the channel nor the payload', async () => {
  using spans = captureSpans();
  const pubsub = redisPubSub({ client });
  const got: string[] = [];
  await pubsub.subscribe('user_4711_orders', payload => {
    got.push(payload);
  });
  await pubsub.publish('user_4711_orders', 'secret');
  await expect.poll(() => got, { timeout: 5000 }).toEqual(['secret']);
  await pubsub.close();

  const publish = spans.named('pubsub.publish');
  const delivery = spans.named('pubsub.deliver');
  for (const span of [publish, delivery]) {
    expect(span.attributes).toEqual({ 'pubsub.backend': 'redis' });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  }
});
