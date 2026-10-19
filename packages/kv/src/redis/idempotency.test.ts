/**
 * The Redis response cache against a real Redis (testcontainers; needs Docker). The rules that
 * matter are atomic ones: two first requests cannot both start, and an owner whose key expired
 * and was taken by another request cannot finish or free the new entry.
 */
import type { StartedRedisContainer } from '@testcontainers/redis';
import { RedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeMiddleware, route } from '@arki/http';
import { IDEMPOTENCY_FAILURES, idempotent } from '@arki/http/idempotency';

import { redisResponseCache } from './idempotency.js';

let container: StartedRedisContainer;
let redis: Redis;
let counter = 0;
const freshKey = () => `k${++counter}-${Math.random().toString(36).slice(2)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const response = { status: 201, headers: { 'content-type': 'application/json' }, body: btoa('{"ok":true}') };

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 120_000);

afterAll(async () => {
  redis.disconnect();
  await container.stop();
});

describe('redisResponseCache', () => {
  it('replays a finished response and refuses a different fingerprint', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    expect(await cache.begin(key, 'fp', 'o1', 5000)).toBe('started');
    expect(await cache.begin(key, 'fp', 'o2', 5000)).toBe('in-progress');
    await cache.finish(key, 'o1', response);
    expect(await cache.begin(key, 'fp', 'o2', 5000)).toEqual({ replay: response });
    expect(await cache.begin(key, 'other', 'o2', 5000)).toBe('conflict');
  });

  it('only one of many simultaneous first requests starts', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => cache.begin(key, 'fp', `o${i}`, 5000)));
    expect(results.filter(result => result === 'started')).toHaveLength(1);
    expect(results.filter(result => result === 'in-progress')).toHaveLength(19);
  });

  it('a stale owner cannot finish or abandon after the key expired and was given to someone else', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    await cache.begin(key, 'fp', 'owner-old', 100);
    await sleep(250);
    expect(await cache.begin(key, 'fp', 'owner-new', 5000)).toBe('started');
    await cache.finish(key, 'owner-old', response);
    await cache.abandon(key, 'owner-old');
    expect(await cache.begin(key, 'fp', 'owner-third', 5000)).toBe('in-progress');
    await cache.finish(key, 'owner-new', response);
    expect(await cache.begin(key, 'fp', 'owner-third', 5000)).toEqual({ replay: response });
  });

  it('the TTL ends the entry, even after finish, and an abandoned key starts at once', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    await cache.begin(key, 'fp', 'o1', 300);
    await cache.finish(key, 'o1', response);
    await sleep(600);
    expect(await cache.begin(key, 'fp-2', 'o2', 5000)).toBe('started');
    await cache.abandon(key, 'o2');
    expect(await cache.begin(key, 'fp-2', 'o3', 5000)).toBe('started');
  });

  it('works under the idempotent() middleware: second request replays, 5xx is not stored', async () => {
    let status = 201;
    let calls = 0;
    const fetch = composeMiddleware(() => {
      calls += 1;
      return Promise.resolve(Response.json({ n: calls }, { status }));
    }, [
      idempotent({
        cache: redisResponseCache(redis),
        scope: () => 'u1',
        routes: [route.post('/orders', { id: 'orders.create', failures: IDEMPOTENCY_FAILURES })],
        ttl: 5000,
      }),
    ]);
    const send = (id: string) =>
      fetch(new Request('http://x/orders', { method: 'POST', headers: { 'idempotency-key': id }, body: '{}' }));
    const id = freshKey();
    await send(id);
    const repeat = await send(id);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    expect(calls).toBe(1);
    status = 503;
    const failing = freshKey();
    await send(failing);
    status = 201;
    const retried = await send(failing);
    expect(retried.status).toBe(201);
    expect(calls).toBe(3);
  });
});
