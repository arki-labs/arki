/**
 * The redis backend against a real Redis 7 (container). `bun run test:redis`;
 * fails without Docker.
 */
import type { StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describePubSubContract } from '../testing/index.js';
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

describePubSubContract('redis on Redis 7', () => Promise.resolve({ pubsub: redisPubSub({ client }) }));

describe('redis connections', () => {
  it('close() closes its subscriber connection and leaves the caller’s client open', async () => {
    const before = await client.client('LIST');
    const pubsub = redisPubSub({ client });
    await pubsub.subscribe('connections_check', () => null);
    const during = await client.client('LIST');
    await pubsub.close();
    expect(await client.ping()).toBe('PONG');
    const after = await client.client('LIST');
    const count = (list: unknown): number => z.string().parse(list).trim().split('\n').length;
    expect(count(during)).toBe(count(before) + 1);
    expect(count(after)).toBe(count(before));
  });
});
