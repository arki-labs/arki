/**
 * The Redis response cache against a real Redis (testcontainers; needs Docker). The rules that
 * matter are atomic ones: two first requests cannot both start, and an owner whose key expired
 * and was taken by another request cannot finish or free the new entry.
 */
import type { StartedRedisContainer } from '@testcontainers/redis';
import { RedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { composeMiddleware, route } from '@arki/http';
import {
  IDEMPOTENCY_FAILURES,
  IdempotencyClaimUnconfirmed,
  idempotencyOwnerId,
  IdempotencyOwnershipLost,
  IdempotencyReleaseUnconfirmed,
  IdempotencyReplayInvalid,
  IdempotencyWriteUnconfirmed,
  idempotent,
} from '@arki/http/idempotency';

import { redisResponseCache } from './idempotency.js';

let container: StartedRedisContainer;
let redis: Redis;
let counter = 0;
const freshKey = () => `k${++counter}-${Math.random().toString(36).slice(2)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const response = { status: 201, headers: { 'content-type': 'application/json' }, body: btoa('{"ok":true}') };
const ownerOne = idempotencyOwnerId.schema.parse('o1');
const ownerTwo = idempotencyOwnerId.schema.parse('o2');
const ownerThree = idempotencyOwnerId.schema.parse('o3');

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
    expect(await cache.begin(key, 'fp', ownerOne)).toBe('started');
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    await cache.finish(key, ownerOne, response, 5000);
    expect(await cache.begin(key, 'fp', ownerTwo)).toEqual({ replay: response });
    expect(await cache.begin(key, 'other', ownerTwo)).toBe('conflict');
  });

  it('only one of many simultaneous first requests starts', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => cache.begin(key, 'fp', idempotencyOwnerId.schema.parse(`o${i}`))),
    );
    expect(results.filter(result => result === 'started')).toHaveLength(1);
    expect(results.filter(result => result === 'in-progress')).toHaveLength(19);
  });

  it('pending reservations survive retention and only their owner can finish', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    await cache.begin(key, 'fp', ownerOne);
    expect(await redis.pttl(`idem:${key}`)).toBe(-1);
    await sleep(250);
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    expect(await cache.finish(key, ownerTwo, response, 100)).toMatchObject({ code: IdempotencyOwnershipLost.code });
    await cache.abandon(key, ownerTwo);
    expect(await cache.finish(key, ownerOne, response, 5000)).toBeUndefined();
    await cache.abandon(key, ownerOne);
    expect(await cache.begin(key, 'fp', ownerThree)).toEqual({ replay: response });
  });

  it('the TTL ends the entry, even after finish, and an abandoned key starts at once', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    await cache.begin(key, 'fp', ownerOne);
    await cache.finish(key, ownerOne, response, 300);
    await sleep(600);
    expect(await cache.begin(key, 'fp-2', ownerTwo)).toBe('started');
    expect(await cache.finish(key, ownerOne, response, 5000)).toMatchObject({ code: IdempotencyOwnershipLost.code });
    expect(await cache.abandon(key, ownerOne)).toBeUndefined();
    expect(await cache.begin(key, 'fp-2', ownerThree)).toBe('in-progress');
    await cache.abandon(key, ownerTwo);
    expect(await cache.begin(key, 'fp-2', ownerThree)).toBe('started');
  });

  it('works under the idempotent() middleware: second request replays, 5xx is retained', async () => {
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
    expect(retried.status).toBe(503);
    expect(calls).toBe(2);
  });
  it('missing ownership and invalid retention never report a confirmed write', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    expect(await cache.finish(key, ownerOne, response, 1000)).toMatchObject({ code: IdempotencyOwnershipLost.code });
    await cache.begin(key, 'fp', ownerOne);
    for (const ttl of [0, -1, Number.NaN, Infinity, 0.5]) {
      expect(await cache.finish(key, ownerOne, response, ttl)).toMatchObject({
        code: IdempotencyWriteUnconfirmed.code,
      });
    }
    expect(await redis.pttl(`idem:${key}`)).toBe(-1);
    await redis.del(`idem:${key}`);
    expect(await cache.finish(key, ownerOne, response, 1000)).toMatchObject({ code: IdempotencyOwnershipLost.code });
  });

  it.each([
    'not-json',
    JSON.stringify({ status: 999, headers: {}, body: '' }),
    JSON.stringify({ status: 200, headers: {}, body: '%%%invalid' }),
    JSON.stringify({ status: 200, headers: { 'bad header': 'value' }, body: '' }),
  ])('invalid replay data fails closed: %s', async malformed => {
    const key = freshKey();
    await redis.set(`idem:${key}`, `${ownerOne}\nfp\n${malformed}`);
    expect(await redisResponseCache(redis).begin(key, 'fp', ownerTwo)).toMatchObject({
      code: IdempotencyReplayInvalid.code,
    });
  });

  it('malformed reservation values and unexpected script replies fail closed', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    await redis.set(`idem:${key}`, 'malformed');
    expect(await cache.begin(key, 'fp', ownerOne)).toMatchObject({ code: IdempotencyClaimUnconfirmed.code });
    vi.spyOn(redis, 'eval').mockResolvedValueOnce('unexpected');
    expect(await cache.finish(key, ownerOne, response, 1000)).toMatchObject({ code: IdempotencyWriteUnconfirmed.code });
    vi.spyOn(redis, 'eval').mockResolvedValueOnce('unexpected');
    expect(await cache.abandon(key, ownerOne)).toMatchObject({ code: IdempotencyReleaseUnconfirmed.code });
    vi.restoreAllMocks();
  });

  it('driver rejections return failures and preserve uncertain reservations', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    const cause = new Error('private Redis rejection');
    vi.spyOn(redis, 'set').mockRejectedValueOnce(cause);
    expect(await cache.begin(key, 'fp', ownerOne)).toMatchObject({ code: IdempotencyClaimUnconfirmed.code, cause });
    await cache.begin(key, 'fp', ownerOne);
    vi.spyOn(redis, 'eval').mockRejectedValueOnce(cause);
    expect(await cache.finish(key, ownerOne, response, 1000)).toMatchObject({
      code: IdempotencyWriteUnconfirmed.code,
      cause,
    });
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    vi.spyOn(redis, 'eval').mockRejectedValueOnce(cause);
    expect(await cache.abandon(key, ownerOne)).toMatchObject({ code: IdempotencyReleaseUnconfirmed.code, cause });
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    vi.restoreAllMocks();
  });

  it('a failed response write does not execute application work again', async () => {
    let calls = 0;
    const fetch = composeMiddleware(() => {
      calls += 1;
      vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('write rejected'));
      return Promise.resolve(Response.json({ committed: true }, { status: 201 }));
    }, [
      idempotent({
        cache: redisResponseCache(redis),
        scope: () => 'u1',
        ttl: 5000,
        routes: [route.post('/orders', { id: 'orders.create', failures: IDEMPOTENCY_FAILURES })],
      }),
    ]);
    const key = freshKey();
    const send = () =>
      fetch(new Request('http://x/orders', { method: 'POST', headers: { 'idempotency-key': key }, body: '{}' }));
    const first = await send();
    const repeat = await send();
    expect(first.status).toBe(500);
    expect(repeat.status).toBe(409);
    expect(calls).toBe(1);
    vi.restoreAllMocks();
  });
  it('rejects delimiter-bearing or empty owners and fingerprints before touching Redis', async () => {
    const cache = redisResponseCache(redis);
    const key = freshKey();
    for (const owner of ['', 'x\nfp']) {
      const malformedOwner = idempotencyOwnerId.schema.parse(owner);
      expect(await cache.begin(key, 'fp', malformedOwner)).toMatchObject({ code: IdempotencyClaimUnconfirmed.code });
      expect(await cache.finish(key, malformedOwner, response, 5000)).toMatchObject({
        code: IdempotencyWriteUnconfirmed.code,
      });
      expect(await cache.abandon(key, malformedOwner)).toMatchObject({ code: IdempotencyReleaseUnconfirmed.code });
      expect(await redis.exists(`idem:${key}`)).toBe(0);
    }
    for (const fingerprint of ['', 'fp\nresponse']) {
      expect(await cache.begin(key, fingerprint, ownerOne)).toMatchObject({ code: IdempotencyClaimUnconfirmed.code });
      expect(await redis.exists(`idem:${key}`)).toBe(0);
    }
    expect(await cache.begin(key, 'fp', ownerOne)).toBe('started');
    const malformedOwner = idempotencyOwnerId.schema.parse(`${ownerOne}\nfp`);
    expect(await cache.finish(key, malformedOwner, response, 5000)).toMatchObject({
      code: IdempotencyWriteUnconfirmed.code,
    });
    expect(await cache.abandon(key, malformedOwner)).toMatchObject({ code: IdempotencyReleaseUnconfirmed.code });
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    expect(await redis.pttl(`idem:${key}`)).toBe(-1);
  });
});
