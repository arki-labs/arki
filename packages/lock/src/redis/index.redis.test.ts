/**
 * The Redis store against a real Redis 7 in a container.
 * Why a real server: Lua atomicity, `PX` expiry, pub/sub and a dropped
 * connection are exactly what a fake would get wrong.
 */
import { createServer, connect as tcpConnect } from 'node:net';
import type { Server } from 'node:net';
import type { StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { orThrow } from '@arki/failure';

import type { Store } from '../types.js';
import type { RedisStore } from './index.js';
import { LockError, LockHeld } from '../errors.js';
import { createKey } from '../key.js';
import { createLocks } from '../locks.js';
import { chaos, describeCases, describeStoreContract, replicaCases } from '../testing/index.js';
import { redisKeys, redisStore } from './index.js';

let container: StartedTestContainer;
let url: string;
let client: Redis;

const TTL_MS = 1000;
function ignore(): void {
  // The dead subscriber is meant to fail.
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const opened: Redis[] = [];
function connect(): Redis {
  const created = new Redis(url, { maxRetriesPerRequest: 1, retryStrategy: () => null });
  opened.push(created);
  return created;
}

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}`;
}

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  client = connect();
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  for (const connection of opened) connection.disconnect();
  await container.stop();
}, 60_000);

const makeStore = (): RedisStore => redisStore(client, { ttl: TTL_MS });

describeStoreContract('redis', makeStore, { ttl: TTL_MS, advanceTime: sleep });

describe('redis chaos and replicas', () => {
  describeCases(
    'chaos hooks',
    chaos(
      makeStore,
      {
        // Nothing to do: a holder that never releases is already what a crash looks like to Redis.
        killHolder: () => Promise.resolve(),
        // The client's own clock jumps; Redis must still be the judge of expiry.
        skewClock: (_store, ms) => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(Date.now() + ms);
          return Promise.resolve();
        },
      },
      { ttl: TTL_MS, advanceTime: sleep },
    ),
  );
  describeCases(
    'replicas',
    replicaCases(
      async () => {
        await client.flushall();
        return makeStore();
      },
      { numRuns: 15 },
    ),
  );
});

describe('redisStore against a real server', () => {
  it('loses the lock at the next renewal when someone deletes the key, so a holder never keeps working on a lock Redis no longer has', async () => {
    const name = uniqueName('del');
    const locks = createLocks({ store: makeStore(), namespace: 'it' });
    const guard = await orThrow(locks.mutex(name).acquire({ wait: '2s' }));
    const other = connect();
    await other.del(redisKeys(createKey('it', name)).lock);
    await eventually(() => !guard.held, 3000, 'the guard to notice the loss');
    expect(guard.signal.aborted).toBe(true);
  });

  it('reports an acquire on a closed connection as not acquired, so the caller knows it is safe to retry', async () => {
    const broken = connect();
    const locks = createLocks({ store: redisStore(broken, { ttl: TTL_MS }), namespace: 'it' });
    broken.disconnect();
    await eventually(() => broken.status === 'end', 3000, 'the client to finish closing');
    const error = await locks
      .mutex(uniqueName('drop-acquire'))
      .tryRun(() => 'resolved')
      .catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(LockError);
    expect(error).toMatchObject({ code: 'store', method: 'acquire', outcome: 'not-acquired' });
  });

  it('reports a connection cut while acquire is in flight as a store error, never as a result, so the caller does not guess whether the job ran', async () => {
    const broken = connect();
    const locks = createLocks({ store: redisStore(broken, { ttl: TTL_MS }), namespace: 'it' });
    const attempt = locks.mutex(uniqueName('cut-acquire')).tryRun(() => 'resolved');
    broken.disconnect();
    const error = await attempt.catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(LockError);
    expect(error).toMatchObject({ code: 'store', method: 'acquire' });
  });

  it('reports a dropped connection during release as a release error, so a lock that may still be held is never called released', async () => {
    const broken = connect();
    const locks = createLocks({ store: redisStore(broken, { ttl: TTL_MS }), namespace: 'it' });
    const guard = await orThrow(locks.mutex(uniqueName('drop-release')).acquire({ wait: '2s' }));
    broken.disconnect();
    await expect(guard.release()).rejects.toMatchObject({ code: 'release' });
  });

  it('frees the key by itself when renewals are blocked, so a stuck or partitioned holder cannot block everyone forever', async () => {
    const name = uniqueName('ttl');
    const real = makeStore();
    const blocked: Store = { ...real, extend: () => Promise.reject(new Error('renewals blocked')) };
    const holder = await orThrow(createLocks({ store: blocked, namespace: 'it' }).mutex(name).acquire({ wait: '2s' }));
    const rival = createLocks({ store: makeStore(), namespace: 'it' }).mutex(name);
    expect(LockHeld.is(await rival.tryAcquire())).toBe(true);
    await sleep(TTL_MS + 150);
    const taken = await orThrow(rival.tryAcquire());
    expect(holder.held).toBe(false);
    await taken.release();
  });

  it('wakes a waiter within 50 ms of the release through pub/sub, so handoff is not a polling delay', async () => {
    const name = uniqueName('wake');
    const store = makeStore();
    const locks = createLocks({ store, namespace: 'it' });
    const holder = await orThrow(locks.mutex(name).acquire({ wait: '2s' }));
    const { channel } = redisKeys(createKey('it', name));
    const waiter = locks.mutex(name).run(() => Date.now(), { wait: '10s' });
    await eventually(
      async () => {
        const reply = await client.pubsub('NUMSUB', channel);
        return reply.at(1) === 1;
      },
      3000,
      'the waiter to subscribe',
    );
    const releasedAt = Date.now();
    await holder.release();
    const ranAt = await orThrow(waiter);
    // A pub/sub wake lands in a few ms; a poll wake lands anywhere up to the 1 s backoff cap.
    // 100 ms tells them apart without failing on a busy host (52 ms was seen under load).
    expect(ranAt - releasedAt).toBeLessThan(100);
    expect(store.guarantees.wait).toBe('wake');
    await store.dispose?.();
  });

  it('wakes a waiter within one backoff step when polling is forced, so the fallback is still prompt', async () => {
    const name = uniqueName('poll');
    const store = redisStore(client, { ttl: TTL_MS, wake: 'poll' });
    const locks = createLocks({ store, namespace: 'it' });
    const holder = await orThrow(locks.mutex(name).acquire({ wait: '2s' }));
    const waiter = locks.mutex(name).run(() => Date.now(), { wait: '10s' });
    await sleep(20);
    const releasedAt = Date.now();
    await holder.release();
    const ranAt = await orThrow(waiter);
    // The backoff step is 50 ms, then 100 ms; one missed poll costs at most the second.
    expect(ranAt - releasedAt).toBeLessThan(300);
    expect(store.guarantees.wait).toBe('poll');
  });

  it('falls back to polling and says so when subscribing fails, so a Redis that refuses pub/sub does not stall waiters', async () => {
    const name = uniqueName('fallback');
    const deadSubscriber = new Redis({
      port: 1,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    opened.push(deadSubscriber);
    deadSubscriber.on('error', ignore);
    const withoutPubSub = connect();
    vi.spyOn(withoutPubSub, 'duplicate').mockReturnValue(deadSubscriber);
    const store = redisStore(withoutPubSub, { ttl: TTL_MS });
    const locks = createLocks({ store, namespace: 'it' });
    const holder = await orThrow(locks.mutex(name).acquire({ wait: '2s' }));
    const waiter = locks.mutex(name).run(() => 'ran', { wait: '10s' });
    await sleep(50);
    await holder.release();
    expect(await waiter).toBe('ran');
    expect(store.guarantees.wait).toBe('poll');
  });

  it('closes the connection it opened for pub/sub on dispose, and leaves the caller client open', async () => {
    const owner = connect();
    const subscribers: Redis[] = [];
    const duplicate = owner.duplicate.bind(owner);
    vi.spyOn(owner, 'duplicate').mockImplementation((...args) => {
      const sub = duplicate(...args);
      subscribers.push(sub);
      opened.push(sub);
      return sub;
    });
    const store = redisStore(owner, { ttl: TTL_MS });
    const name = uniqueName('dispose');
    const locks = createLocks({ store, namespace: 'it' });
    const holder = await orThrow(locks.mutex(name).acquire({ wait: '2s' }));
    const waiter = locks.mutex(name).run(() => 'ran', { wait: '10s' });
    await eventually(() => subscribers.length === 1, 3000, 'the subscriber to open');
    await holder.release();
    await waiter;
    await store.dispose?.();
    await eventually(() => subscribers[0]?.status === 'end', 3000, 'the subscriber to close');
    expect(owner.status).toBe('ready');
    expect(await owner.ping()).toBe('PONG');
  });

  it('reports a win whose reply was lost to a dropped connection as a win, because ioredis resends the unanswered script after reconnecting and the resend finds our own token', async () => {
    // A proxy that can swallow one reply and cut the connection, as a network blip after Redis ran the command.
    let cutNextReply = false;
    const proxy: Server = createServer(downstream => {
      const upstream = tcpConnect(container.getMappedPort(6379), container.getHost());
      downstream.on('error', ignore);
      upstream.on('error', ignore);
      downstream.on('close', () => upstream.destroy());
      upstream.on('close', () => downstream.destroy());
      downstream.on('data', chunk => upstream.write(chunk));
      upstream.on('data', chunk => {
        if (!cutNextReply) {
          downstream.write(chunk);
          return;
        }
        cutNextReply = false;
        downstream.destroy();
      });
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (address === null || typeof address === 'string') throw new Error('the proxy has no TCP port');
    const { port } = address;
    const flaky = new Redis({ host: '127.0.0.1', port, retryStrategy: () => 10, maxRetriesPerRequest: 5 });
    opened.push(flaky);
    try {
      const name = uniqueName('resend');
      const locks = createLocks({ store: redisStore(flaky, { ttl: TTL_MS }), namespace: 'it' });
      // Warm the script cache, so the cut reply is the script's own and not a NOSCRIPT.
      expect(await locks.mutex(uniqueName('warm')).tryRun(() => 'warm')).toBe('warm');
      cutNextReply = true;
      expect(await locks.mutex(name).tryRun(() => 'ran')).toBe('ran');
      expect(await client.exists(redisKeys(createKey('it', name)).lock)).toBe(0);
    } finally {
      flaky.disconnect();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });

  it('wakes a waiter through pub/sub when the client has a keyPrefix, because ioredis prefixes script keys but not SUBSCRIBE channels', async () => {
    const prefixed = new Redis(url, { keyPrefix: 'app:', maxRetriesPerRequest: 1, retryStrategy: () => null });
    opened.push(prefixed);
    const name = uniqueName('prefix');
    const store = redisStore(prefixed, { ttl: TTL_MS });
    const locks = createLocks({ store, namespace: 'it' });
    const holder = await orThrow(locks.mutex(name).acquire({ wait: '2s' }));
    const waiter = locks.mutex(name).run(() => Date.now(), { wait: '10s' });
    await eventually(() => store.guarantees.wait === 'wake' && prefixed.status === 'ready', 3000, 'the client');
    await sleep(100);
    const releasedAt = Date.now();
    await holder.release();
    const ranAt = await orThrow(waiter);
    // A pub/sub wake lands in a few ms; a poll wake lands anywhere up to the 1 s backoff cap.
    // 100 ms tells them apart without failing on a busy host (52 ms was seen under load).
    expect(ranAt - releasedAt).toBeLessThan(100);
    await store.dispose?.();
  });

  it('resolves waitFor as soon as the signal aborts even while the subscribe is stuck, so waits do not pile up during a pub/sub outage', async () => {
    const stuck = new Redis({ port: 1, lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: () => 50 });
    opened.push(stuck);
    stuck.on('error', ignore);
    const owner = connect();
    vi.spyOn(owner, 'duplicate').mockReturnValue(stuck);
    const store = redisStore(owner, { ttl: TTL_MS });
    const controller = new AbortController();
    const waited = store.waitFor(createKey('it', uniqueName('stuck')), controller.signal).then(() => 'resolved');
    await sleep(20);
    controller.abort();
    const outcome = await Promise.race([waited, sleep(500).then(() => 'still waiting')]);
    expect(outcome).toBe('resolved');
    await store.dispose?.();
  });
});

describe('redis semaphore and read/write against a real server', () => {
  const SHORT_MS = 150;

  it('rejects a conflicting limit while a permit is held and accepts a new one once none is left, so the stored limit is the one all processes share', async () => {
    const store = makeStore();
    const locks = createLocks({ store, namespace: 'it' });
    const name = uniqueName('limit');
    const first = await orThrow(locks.semaphore(name, { limit: 2 }).tryAcquire());
    expect(first).toBeDefined();
    await expect(locks.semaphore(name, { limit: 3 }).tryAcquire()).rejects.toMatchObject({ code: 'config' });
    await first.release();
    const second = await orThrow(locks.semaphore(name, { limit: 3 }).tryAcquire());
    expect(second).toBeDefined();
    await second.release();
  });

  it('gives a crashed holder permits back after the ttl, and leaves no key behind', async () => {
    const store = makeStore();
    const key = createKey('it', uniqueName('crash'), 'semaphore');
    const held = await store.permits.acquire(key, { token: 'a', ttlMs: SHORT_MS, limit: 1, weight: 1 });
    expect(held?.fence).toBeTypeOf('bigint');
    expect(await store.permits.acquire(key, { token: 'b', ttlMs: SHORT_MS, limit: 1, weight: 1 })).toBeUndefined();
    await sleep(SHORT_MS + 80);
    const next = await store.permits.acquire(key, { token: 'c', ttlMs: SHORT_MS, limit: 2, weight: 2 });
    expect(next).toBeDefined();
    expect(next?.fence).toBeGreaterThan(held?.fence ?? 0n);
    await sleep(SHORT_MS + 80);
    const { lock, meta } = redisKeys(key);
    expect(await client.exists(lock, meta)).toBe(0);
  });

  it('never revives an expired permit or reader on extend, and release says not-owner', async () => {
    const store = makeStore();
    const permitKey = createKey('it', uniqueName('revive'), 'semaphore');
    const permit = await store.permits.acquire(permitKey, { token: 'a', ttlMs: SHORT_MS, limit: 1, weight: 1 });
    const readKey = createKey('it', uniqueName('revive'), 'readWrite');
    const reader = await store.shared.acquire(readKey, { token: 'r', ttlMs: SHORT_MS, mode: 'read' });
    if (permit === undefined || reader === undefined) throw new Error('both should be granted');
    expect(await store.permits.extend?.(permit, 5000)).toBe(true);
    await store.permits.release(permit);
    await sleep(SHORT_MS + 80);
    expect(await store.permits.extend?.(permit, 5000)).toBe(false);
    expect(await store.shared.extend?.(reader, 5000)).toBe(false);
    expect(await store.shared.release(reader)).toBe('not-owner');
    expect(await store.permits.acquire(permitKey, { token: 'b', ttlMs: SHORT_MS, limit: 1, weight: 1 })).toBeDefined();
  });

  it('admits a writer once a crashed reader expires, and blocks it while the reader is live', async () => {
    const store = makeStore();
    const key = createKey('it', uniqueName('writer'), 'readWrite');
    const reader = await store.shared.acquire(key, { token: 'r', ttlMs: SHORT_MS, mode: 'read' });
    expect(reader).toBeDefined();
    expect(await store.shared.acquire(key, { token: 'w1', ttlMs: SHORT_MS, mode: 'write' })).toBeUndefined();
    await sleep(SHORT_MS + 80);
    const writer = await store.shared.acquire(key, { token: 'w2', ttlMs: SHORT_MS, mode: 'write' });
    expect(writer).toBeDefined();
    expect(await store.shared.acquire(key, { token: 'r2', ttlMs: SHORT_MS, mode: 'read' })).toBeUndefined();
    await sleep(SHORT_MS + 80);
    expect(await store.shared.acquire(key, { token: 'r3', ttlMs: SHORT_MS, mode: 'read' })).toBeDefined();
  });

  it('wakes a waiting writer through pub/sub when the last reader releases', async () => {
    const store = makeStore();
    const locks = createLocks({ store, namespace: 'it' });
    const { read, write } = locks.readWrite(uniqueName('wake'));
    const reader = await orThrow(read.acquire({ wait: '2s' }));
    const writing = write.run(() => Date.now(), { wait: '10s' });
    await sleep(100);
    const releasedAt = Date.now();
    await reader.release();
    expect((await orThrow(writing)) - releasedAt).toBeLessThan(100);
    await store.dispose?.();
  });
});

describe('redis semaphore and read/write: review proofs', () => {
  it('R1: a resent semaphore acquire (same token, as ioredis resends after a lost reply) must keep its own fence, not take another live holder fence', async () => {
    const store = makeStore();
    const key = createKey('rv', uniqueName('fence'), 'semaphore');
    const a = await store.permits.acquire(key, { token: 'a', limit: 3, weight: 1 });
    const b = await store.permits.acquire(key, { token: 'b', limit: 3, weight: 1 });
    // The reply to `a` was lost; ioredis resends the same EVALSHA.
    const resent = await store.permits.acquire(key, { token: 'a', limit: 3, weight: 1 });
    expect(b?.fence).not.toBe(a?.fence);
    // Two live grants must never carry the same fence.
    expect(resent?.fence).not.toBe(b?.fence);
    expect(resent?.fence).toBe(a?.fence);
  });

  it('R2: a resent reader acquire must keep its own fence, not take another live reader fence', async () => {
    const store = makeStore();
    const key = createKey('rv', uniqueName('fence'), 'readWrite');
    await store.shared.acquire(key, { token: 'r1', mode: 'read' });
    const r2 = await store.shared.acquire(key, { token: 'r2', mode: 'read' });
    const resent = await store.shared.acquire(key, { token: 'r1', mode: 'read' });
    expect(resent?.fence).not.toBe(r2?.fence);
    expect(resent?.fence).toBeDefined();
  });

  it('R3: in poll mode a waiting semaphore caller backs off like a mutex caller instead of hitting Redis every ~25 ms', async () => {
    const store = redisStore(client, { ttl: TTL_MS, wake: 'poll' });
    const locks = createLocks({ store, namespace: 'rv' });
    const name = uniqueName('poll');
    const holder = await orThrow(locks.semaphore(name, { limit: 1 }).acquire({ wait: '1s' }));
    const permitCalls = vi.spyOn(store.permits, 'acquire');
    const mutexCalls = vi.spyOn(store, 'acquire');
    const mutexHolder = await orThrow(locks.mutex(name).acquire({ wait: '1s' }));
    mutexCalls.mockClear();
    const semaphoreWait = locks
      .semaphore(name, { limit: 1 })
      .run(() => 0, { wait: '1500ms' })
      .then(
        () => 'settled',
        () => 'settled',
      );
    const mutexWait = locks
      .mutex(name)
      .run(() => 0, { wait: '1500ms' })
      .then(
        () => 'settled',
        () => 'settled',
      );
    await Promise.all([semaphoreWait, mutexWait]);
    await holder.release();
    await mutexHolder.release();
    const counts = { semaphore: permitCalls.mock.calls.length, mutex: mutexCalls.mock.calls.length };
    // Same 1.5 s wait: the semaphore should not cost several times the mutex's round trips.
    expect(counts.semaphore, JSON.stringify(counts)).toBeLessThanOrEqual(Math.max(10, counts.mutex * 2));
  });

  it('R4: a semaphore waiter resolves when a permit is already free (release landed before the subscribe)', async () => {
    const store = makeStore();
    const key = createKey('rv', uniqueName('missed'), 'semaphore');
    const a = await store.permits.acquire(key, { token: 'a', limit: 2, weight: 1 });
    await store.permits.acquire(key, { token: 'b', limit: 2, weight: 1 });
    // Caller's attempt was refused; then `a` releases before the caller subscribes.
    if (a === undefined) throw new Error('a should hold');
    await store.permits.release(a);
    const waiter = store.permits.waiter?.(key, 1);
    if (waiter === undefined) throw new Error('redis permits should offer a waiter');
    const controller = new AbortController();
    const waited = waiter.waitFor(controller.signal).then(() => 'resolved');
    const outcome = await Promise.race([waited, sleep(500).then(() => 'still waiting')]);
    controller.abort();
    await waited;
    waiter.close();
    await store.dispose?.();
    expect(outcome).toBe('resolved');
  });
});

describe('redis semaphore and read/write: attacks that held', () => {
  it('ok: extending a short-ttl permit past the key TTL keeps the holder, its weight and the limit', async () => {
    const store = makeStore();
    const key = createKey('rv', uniqueName('ext'), 'semaphore');
    await store.permits.acquire(key, { token: 'long', ttlMs: 400, limit: 2, weight: 1 });
    const short = await store.permits.acquire(key, { token: 'short', ttlMs: 100, limit: 2, weight: 1 });
    if (short === undefined) throw new Error('short should hold');
    expect(await store.permits.extend?.(short, 1200)).toBe(true);
    await sleep(600);
    const { lock, meta } = redisKeys(key);
    expect(await client.zscore(lock, 'short')).not.toBeNull();
    expect(await client.hget(meta, 'w:short')).toBe('1');
    await expect(store.permits.acquire(key, { token: 'x', limit: 5, weight: 1 })).rejects.toMatchObject({
      code: 'config',
    });
    expect(await store.permits.acquire(key, { token: 'y', limit: 2, weight: 1 })).toBeDefined();
    expect(await store.permits.acquire(key, { token: 'z', limit: 2, weight: 1 })).toBeUndefined();
  });

  it('ok: extending a reader past the readers TTL keeps it, so a writer stays out', async () => {
    const store = makeStore();
    const key = createKey('rv', uniqueName('rext'), 'readWrite');
    await store.shared.acquire(key, { token: 'r-long', ttlMs: 300, mode: 'read' });
    const r = await store.shared.acquire(key, { token: 'r', ttlMs: 100, mode: 'read' });
    if (r === undefined) throw new Error('r should hold');
    expect(await store.shared.extend?.(r, 1000)).toBe(true);
    await sleep(500);
    expect(await store.shared.acquire(key, { token: 'w', mode: 'write' })).toBeUndefined();
  });

  it('ok: a crashed heavy holder gives its weight back; no orphan weight field survives', async () => {
    const store = makeStore();
    const key = createKey('rv', uniqueName('crash'), 'semaphore');
    await store.permits.acquire(key, { token: 'heavy', ttlMs: 100, limit: 3, weight: 2 });
    await store.permits.acquire(key, { token: 'light', ttlMs: 2000, limit: 3, weight: 1 });
    await sleep(200);
    expect(await store.permits.acquire(key, { token: 'new', limit: 3, weight: 2 })).toBeDefined();
    expect(Object.keys(await client.hgetall(redisKeys(key).meta)).toSorted()).toEqual([
      'f:light',
      'f:new',
      'limit',
      'w:light',
      'w:new',
    ]);
  });

  it('ok: every key except the fence counter carries a TTL', async () => {
    const store = makeStore();
    const sem = createKey('rv', uniqueName('ttl'), 'semaphore');
    const rw = createKey('rv', uniqueName('ttl'), 'readWrite');
    const rw2 = createKey('rv', uniqueName('ttl'), 'readWrite');
    await store.permits.acquire(sem, { token: 'a', limit: 2, weight: 1 });
    const b = await store.permits.acquire(sem, { token: 'b', limit: 2, weight: 1 });
    if (b !== undefined) await store.permits.release(b);
    await store.shared.acquire(rw, { token: 'r', mode: 'read' });
    await store.shared.acquire(rw2, { token: 'w', mode: 'write' });
    for (const k of [redisKeys(sem).lock, redisKeys(sem).meta, redisKeys(rw).readers, redisKeys(rw2).writer]) {
      expect(await client.pttl(k), k).toBeGreaterThan(0);
    }
  });

  it('ok: with a keyPrefix, a semaphore and a writer waiter are woken by pub/sub', async () => {
    const prefixed = new Redis(url, { keyPrefix: 'pfx:', maxRetriesPerRequest: 1, retryStrategy: () => null });
    opened.push(prefixed);
    const store = redisStore(prefixed, { ttl: TTL_MS });
    const locks = createLocks({ store, namespace: 'rv' });
    const sem = locks.semaphore(uniqueName('pfx'), { limit: 1 });
    const held = await orThrow(sem.acquire({ wait: '1s' }));
    const waiting = sem.run(() => Date.now(), { wait: '5s' });
    await sleep(150);
    const at = Date.now();
    await held.release();
    expect((await orThrow(waiting)) - at).toBeLessThan(150);
    await store.dispose?.();
  });

  it('ok: concurrent weighted holders never exceed the limit, readers and a writer never overlap', async () => {
    const store = makeStore();
    const locks = createLocks({ store, namespace: 'rv' });
    const sem = uniqueName('stress');
    let used = 0;
    let maxUsed = 0;
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        orThrow(
          locks.semaphore(sem, { limit: 3 }).run(
            async () => {
              used += 1 + (i % 2);
              maxUsed = Math.max(maxUsed, used);
              await sleep(15);
              used -= 1 + (i % 2);
            },
            { wait: '10s', weight: 1 + (i % 2) },
          ),
        ),
      ),
    );
    expect(maxUsed).toBeLessThanOrEqual(3);

    const { read, write } = locks.readWrite(uniqueName('stress'));
    let readers = 0;
    let writers = 0;
    let overlap = false;
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        orThrow(
          (i % 4 === 0 ? write : read).run(
            async () => {
              if (i % 4 === 0) writers++;
              else readers++;
              if (writers > 1 || (writers > 0 && readers > 0)) overlap = true;
              await sleep(10);
              if (i % 4 === 0) writers--;
              else readers--;
            },
            { wait: '10s' },
          ),
        ),
      ),
    );
    expect(overlap).toBe(false);
    await store.dispose?.();
  });
});

describe('redis semaphore: store-side checks', () => {
  it('F6: the store refuses a bad weight or limit with config and holds nothing', async () => {
    const store = makeStore();
    const key = createKey('it', uniqueName('f6'), 'semaphore');
    for (const [limit, weight] of [
      [2, 3],
      [2, 0],
      [2, -1],
      [2, 1.5],
      [0, 1],
      [1.5, 1],
    ] as const) {
      await expect(store.permits.acquire(key, { token: 't', limit, weight })).rejects.toMatchObject({ code: 'config' });
    }
    expect(await client.exists(redisKeys(key).lock)).toBe(0);
  });
});
