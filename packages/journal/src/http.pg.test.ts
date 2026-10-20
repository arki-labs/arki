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
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
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

import { responseCache } from './http.js';
import { initJournal } from './journal.js';
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

  it('pending reservations survive replay retention and only their owner can finish', async () => {
    const key = freshKey();
    const stale = cacheA();
    const fresh = cacheB();
    expect(await stale.begin(key, 'fp', ownerOne)).toBe('started');
    await sleep(250);
    expect(await fresh.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    // This case checks ownership, not expiry; its readbacks must survive a busy database.
    expect(await fresh.finish(key, ownerTwo, response, 60_000)).toMatchObject({ code: IdempotencyOwnershipLost.code });
    expect(await fresh.abandon(key, ownerTwo)).toBeUndefined();
    expect(await stale.finish(key, ownerOne, response, 60_000)).toBeUndefined();
    expect(await fresh.begin(key, 'fp', ownerTwo)).toEqual({ replay: response });
    expect(await fresh.abandon(key, ownerOne)).toBeUndefined();
    expect(await fresh.begin(key, 'fp', ownerTwo)).toEqual({ replay: response });
  });

  it('after the TTL the key can be used again, with a different request too', async () => {
    const key = freshKey();
    const cache = cacheA();
    expect(await cache.begin(key, 'fp-1', ownerOne)).toBe('started');
    expect(await cache.finish(key, ownerOne, response, 1500)).toBeUndefined();
    expect(await cache.begin(key, 'fp-1', ownerTwo)).toEqual({ replay: response });
    await sleep(1800);
    expect(await cache.begin(key, 'fp-2', ownerThree)).toBe('started');
    expect(await cache.finish(key, ownerOne, response, 5000)).toMatchObject({ code: IdempotencyOwnershipLost.code });
    expect(await cache.abandon(key, ownerOne)).toBeUndefined();
    expect(await cache.begin(key, 'fp-2', ownerTwo)).toBe('in-progress');
  });

  it('an abandoned key can be taken at once', async () => {
    const key = freshKey();
    const cache = cacheA();
    expect(await cache.begin(key, 'fp', ownerOne)).toBe('started');
    expect(await cache.abandon(key, ownerOne)).toBeUndefined();
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('started');
  });

  it('5xx is cached because application work may already have committed', async () => {
    let status = 503;
    const { fetch, calls } = app(cacheA(), () => Promise.resolve(new Response('x', { status })));
    const headers = { 'x-user': 'u1', 'idempotency-key': freshKey() };
    const failed = await fetch(post({}, headers));
    status = 201;
    const retried = await fetch(post({}, headers));
    expect([failed.status, retried.status]).toEqual([503, 503]);
    expect(calls()).toBe(1);
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
    expect(await cacheA().begin('plain-command-key', 'fp', ownerOne)).toBe('started');
    const [row] = await dbA.select().from(tables.receipts).where(eq(tables.receipts.key, 'plain-command-key'));
    expect(row?.command).toBe('pay');
    expect(row?.expiresAt).toBeNull();
  });
  it('missing ownership and invalid retention never report a confirmed write', async () => {
    const key = freshKey();
    const cache = cacheA();
    expect(await cache.finish(key, ownerOne, response, 1000)).toMatchObject({ code: IdempotencyOwnershipLost.code });
    expect(await cache.begin(key, 'fp', ownerOne)).toBe('started');
    for (const ttl of [0, -1, Number.NaN, Infinity, 0.5]) {
      expect(await cache.finish(key, ownerOne, response, ttl)).toMatchObject({
        code: IdempotencyWriteUnconfirmed.code,
      });
    }
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    await dbA.delete(tables.receipts).where(eq(tables.receipts.key, `http:${key}`));
    expect(await cache.finish(key, ownerOne, response, 1000)).toMatchObject({ code: IdempotencyOwnershipLost.code });
  });

  it.each([
    { status: 999, headers: {}, body: '' },
    { status: 200, headers: {}, body: '%%%invalid' },
    { status: 200, headers: { 'bad header': 'value' }, body: '' },
  ])('invalid stored responses fail closed: %j', async malformed => {
    const key = freshKey();
    const cache = cacheA();
    expect(await cache.begin(key, 'fp', ownerOne)).toBe('started');
    await dbA
      .update(tables.receipts)
      .set({ response: malformed, expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(tables.receipts.key, `http:${key}`));
    expect(await cache.begin(key, 'fp', ownerTwo)).toMatchObject({ code: IdempotencyReplayInvalid.code });
  });

  it('driver rejections return failures and leave uncertain work reserved', async () => {
    const key = freshKey();
    const cache = cacheA();
    const cause = new Error('private database rejection');
    vi.spyOn(dbA, 'insert').mockImplementationOnce(() => {
      throw cause;
    });
    expect(await cache.begin(key, 'fp', ownerOne)).toMatchObject({ code: IdempotencyClaimUnconfirmed.code, cause });
    expect(await cache.begin(key, 'fp', ownerOne)).toBe('started');
    vi.spyOn(dbA, 'update').mockImplementationOnce(() => {
      throw cause;
    });
    expect(await cache.finish(key, ownerOne, response, 1000)).toMatchObject({
      code: IdempotencyWriteUnconfirmed.code,
      cause,
    });
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    vi.spyOn(dbA, 'delete').mockImplementationOnce(() => {
      throw cause;
    });
    expect(await cache.abandon(key, ownerOne)).toMatchObject({ code: IdempotencyReleaseUnconfirmed.code, cause });
    expect(await cache.begin(key, 'fp', ownerTwo)).toBe('in-progress');
    vi.restoreAllMocks();
  });

  it('asynchronous driver rejection returns unconfirmed outcomes', async () => {
    const disconnectedPool = new pg.Pool({ connectionString: container.getConnectionUri() });
    const disconnectedDb = drizzle({ client: disconnectedPool });
    const cache = responseCache(disconnectedDb, tables);
    const key = freshKey();
    expect(await cache.begin(key, 'fp', ownerOne)).toBe('started');
    await disconnectedPool.end();
    expect(await cache.begin(freshKey(), 'fp', ownerOne)).toMatchObject({ code: IdempotencyClaimUnconfirmed.code });
    expect(await cache.finish(key, ownerOne, response, 1000)).toMatchObject({ code: IdempotencyWriteUnconfirmed.code });
    expect(await cache.abandon(key, ownerOne)).toMatchObject({ code: IdempotencyReleaseUnconfirmed.code });
    expect(await cacheB().begin(key, 'fp', ownerTwo)).toBe('in-progress');
  });

  it('a failed response write does not execute application work again', async () => {
    const application = app(cacheA(), () => {
      vi.spyOn(dbA, 'update').mockImplementationOnce(() => {
        throw new Error('write rejected');
      });
      return Promise.resolve(Response.json({ committed: true }, { status: 201 }));
    });
    const headers = { 'x-user': 'u1', 'idempotency-key': freshKey() };
    const first = await application.fetch(post({}, headers));
    expect(first.status).toBe(500);
    const repeat = await application.fetch(post({}, headers));
    expect(repeat.status).toBe(409);
    expect(application.calls()).toBe(1);
    vi.restoreAllMocks();
  });

  it('pruning preserves unresolved legacy claims and live replays', async () => {
    const pending = freshKey();
    const legacyPending = freshKey();
    const live = freshKey();
    const expired = freshKey();
    const recentExpired = freshKey();
    const old = new Date(Date.now() - 120_000);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    for (const key of [pending, legacyPending, live, expired, recentExpired]) {
      expect(await cacheA().begin(key, 'fp', ownerOne)).toBe('started');
    }
    await dbA
      .update(tables.receipts)
      .set({ recordedAt: old })
      .where(
        inArray(
          tables.receipts.key,
          [pending, legacyPending, live, expired].map(key => `http:${key}`),
        ),
      );
    await dbA
      .update(tables.receipts)
      .set({ expiresAt: past })
      .where(eq(tables.receipts.key, `http:${legacyPending}`));
    for (const [key, expiresAt] of [
      [live, future],
      [expired, past],
      [recentExpired, past],
    ] as const) {
      await dbA
        .update(tables.receipts)
        .set({ response, expiresAt })
        .where(eq(tables.receipts.key, `http:${key}`));
    }
    const journal = initJournal({ tables }).compose({});
    // An application's command may have the same name; only the reserved key namespace
    // plus the discriminator identifies an HTTP reservation.
    const commandKey = freshKey();
    await dbA.insert(tables.receipts).values({
      key: commandKey,
      command: 'http.response',
      input: {},
      commandId: 'command',
      recordedAt: old,
    });
    expect(await journal.pruneReceipts(dbA, { before: past })).toBe(2);
    expect(await dbA.select().from(tables.receipts).where(eq(tables.receipts.key, commandKey))).toEqual([]);
    const rows = await dbA
      .select({ key: tables.receipts.key })
      .from(tables.receipts)
      .where(
        inArray(
          tables.receipts.key,
          [pending, legacyPending, live, expired, recentExpired].map(key => `http:${key}`),
        ),
      );
    expect(rows.map(row => row.key).toSorted()).toEqual(
      [pending, legacyPending, live, recentExpired].map(key => `http:${key}`).toSorted(),
    );
    expect(await cacheB().begin(legacyPending, 'fp', ownerTwo)).toBe('in-progress');
  });
});
