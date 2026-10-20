/**
 * The Postgres response cache on real Postgres with two connections: the first-request race and
 * the stale-owner rule need a second writer waiting on a row lock, which PGlite cannot show.
 * Needs Docker: starts a `postgres:16` container through testcontainers.
 *
 * The `idempotent()` middleware from `@arki/http/idempotency` runs on top of the cache, so the
 * tests read as the client sees them: a repeat, a different body, a duplicate in flight.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeMiddleware, route } from '@arki/http';
import { IDEMPOTENCY_FAILURES, idempotencyOwnerId, idempotent } from '@arki/http/idempotency';

import { responseCache } from './http.js';
import { journalTables } from './pg.js';

const tables = journalTables();
let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: ReturnType<typeof drizzle>;
let dbB: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cacheA = () => responseCache(dbA, tables);
const cacheB = () => responseCache(dbB, tables);
let counter = 0;
const freshKey = () => `k${++counter}-${Math.random().toString(36).slice(2)}`;
const response = { status: 201, headers: { 'content-type': 'application/json' }, body: btoa('{"ok":true}') };
const ownerOne = idempotencyOwnerId.schema.parse('o1');
const ownerTwo = idempotencyOwnerId.schema.parse('o2');
const ownerThree = idempotencyOwnerId.schema.parse('o3');

const post = (body: unknown, headers: Record<string, string>) =>
  new Request('http://x/orders', { method: 'POST', headers, body: JSON.stringify(body) });

function app(cache: ReturnType<typeof cacheA>, handler: () => Promise<Response>, ttl = 60_000) {
  let calls = 0;
  const fetch = composeMiddleware(async () => {
    calls += 1;
    return await handler();
  }, [
    idempotent({
      cache,
      scope: req => req.headers.get('x-user') ?? undefined,
      routes: [route.post('/orders', { id: 'orders.create', failures: IDEMPOTENCY_FAILURES })],
      ttl,
      replayHeaders: ['content-type', 'x-order'],
    }),
  ]);
  return { fetch, calls: () => calls };
}

describe('journal response cache (Postgres)', () => {
  it('second request replays body and allowlisted headers', async () => {
    const { fetch, calls } = app(cacheA(), () =>
      Promise.resolve(
        Response.json({ id: 1 }, { status: 201, headers: { 'x-order': 'ord_1', 'set-cookie': 'secret=1' } }),
      ),
    );
    const headers = { 'x-user': 'u1', 'idempotency-key': freshKey() };
    await fetch(post({ a: 1 }, headers));
    const replay = await fetch(post({ a: 1 }, headers));
    expect(calls()).toBe(1);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ id: 1 });
    expect(replay.headers.get('x-order')).toBe('ord_1');
    expect(replay.headers.get('set-cookie')).toBeNull();
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  it('a different body under the same key is 422', async () => {
    const { fetch } = app(cacheA(), () => Promise.resolve(Response.json({}, { status: 201 })));
    const headers = { 'x-user': 'u1', 'idempotency-key': freshKey() };
    await fetch(post({ a: 1 }, headers));
    const different = await fetch(post({ a: 2 }, headers));
    expect(different.status).toBe(422);
  });

  it('two connections racing the same first request: one runs, the other gets 409, then both replay', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const slow = async () => {
      await gate;
      return Response.json({ id: 9 }, { status: 201 });
    };
    const one = app(cacheA(), slow);
    const two = app(cacheB(), slow);
    const headers = { 'x-user': 'u1', 'idempotency-key': freshKey() };
    const firstA = one.fetch(post({ a: 1 }, headers));
    const firstB = two.fetch(post({ a: 1 }, headers));
    // Only the loser can answer while the gate is shut: the winner is inside the handler. So the
    // first answer is the loser's, however slow the machine is (a fixed sleep was flaky under load).
    const loser = await Promise.race([firstA, firstB]);
    expect(loser.status).toBe(409);
    release();
    const results = await Promise.all([firstA, firstB]);
    expect(results.map(res => res.status).toSorted()).toEqual([201, 409]);
    expect(one.calls() + two.calls()).toBe(1);
    const replay = await two.fetch(post({ a: 1 }, headers));
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  it('a stale owner cannot finish after the entry expired and was given to someone else', async () => {
    const key = freshKey();
    const oldOwner = idempotencyOwnerId.schema.parse('owner-old');
    const newOwner = idempotencyOwnerId.schema.parse('owner-new');
    const thirdOwner = idempotencyOwnerId.schema.parse('owner-third');
    const stale = cacheA();
    const fresh = cacheB();
    expect(await stale.begin(key, 'fp', oldOwner, 100)).toBe('started');
    await sleep(250);
    expect(await fresh.begin(key, 'fp', newOwner, 60_000)).toBe('started');
    await stale.finish(key, oldOwner, response);
    await stale.abandon(key, oldOwner);
    // The new owner still holds a running entry: the old owner's finish and abandon did nothing.
    expect(await fresh.begin(key, 'fp', thirdOwner, 60_000)).toBe('in-progress');
    await fresh.finish(key, newOwner, response);
    expect(await fresh.begin(key, 'fp', thirdOwner, 60_000)).toEqual({ replay: response });
  });

  it('after the TTL the key can be used again, with a different request too', async () => {
    const key = freshKey();
    const cache = cacheA();
    await cache.begin(key, 'fp-1', ownerOne, 1500);
    await cache.finish(key, ownerOne, response);
    expect(await cache.begin(key, 'fp-1', ownerTwo, 1500)).toEqual({ replay: response });
    await sleep(1800);
    expect(await cache.begin(key, 'fp-2', ownerThree, 60_000)).toBe('started');
  });

  it('an abandoned key can be taken at once', async () => {
    const key = freshKey();
    const cache = cacheA();
    await cache.begin(key, 'fp', ownerOne, 60_000);
    await cache.abandon(key, ownerOne);
    expect(await cache.begin(key, 'fp', ownerTwo, 60_000)).toBe('started');
  });

  it('5xx is not cached: the retry runs the handler again', async () => {
    let status = 503;
    const { fetch, calls } = app(cacheA(), () => Promise.resolve(new Response('x', { status })));
    const headers = { 'x-user': 'u1', 'idempotency-key': freshKey() };
    const failed = await fetch(post({}, headers));
    status = 201;
    const retried = await fetch(post({}, headers));
    expect([failed.status, retried.status]).toEqual([503, 201]);
    expect(calls()).toBe(2);
  });

  it('unauthenticated request never replays', async () => {
    const { fetch, calls } = app(cacheA(), () => Promise.resolve(Response.json({}, { status: 201 })));
    const headers = { 'idempotency-key': freshKey() };
    await fetch(post({}, headers));
    const again = await fetch(post({}, headers));
    expect(calls()).toBe(2);
    expect(again.headers.get('idempotent-replayed')).toBeNull();
  });

  it('keeps command receipts apart: the cache only touches rows under its own prefix', async () => {
    await dbA
      .insert(tables.receipts)
      .values({ key: 'plain-command-key', command: 'pay', input: {}, commandId: 'cmd_1', result: {} });
    await cacheA().begin('plain-command-key', 'fp', ownerOne, 60_000);
    const [row] = await dbA.select().from(tables.receipts).where(eq(tables.receipts.key, 'plain-command-key'));
    expect(row?.command).toBe('pay');
    expect(row?.expiresAt).toBeNull();
  });
});
