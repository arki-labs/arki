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

import type { Store } from '../types.js';
import type { RedisStore } from './index.js';
import { LockError } from '../errors.js';
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
    const guard = await locks.mutex(name).acquire({ wait: '2s' });
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
    const guard = await locks.mutex(uniqueName('drop-release')).acquire({ wait: '2s' });
    broken.disconnect();
    await expect(guard.release()).rejects.toMatchObject({ code: 'release' });
  });

  it('frees the key by itself when renewals are blocked, so a stuck or partitioned holder cannot block everyone forever', async () => {
    const name = uniqueName('ttl');
    const real = makeStore();
    const blocked: Store = { ...real, extend: () => Promise.reject(new Error('renewals blocked')) };
    const holder = await createLocks({ store: blocked, namespace: 'it' }).mutex(name).acquire({ wait: '2s' });
    const rival = createLocks({ store: makeStore(), namespace: 'it' }).mutex(name);
    expect(await rival.tryAcquire()).toBeUndefined();
    await sleep(TTL_MS + 150);
    const taken = await rival.tryAcquire();
    expect(taken).toBeDefined();
    expect(holder.held).toBe(false);
    await taken?.release();
  });

  it('wakes a waiter within 50 ms of the release through pub/sub, so handoff is not a polling delay', async () => {
    const name = uniqueName('wake');
    const store = makeStore();
    const locks = createLocks({ store, namespace: 'it' });
    const holder = await locks.mutex(name).acquire({ wait: '2s' });
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
    const ranAt = await waiter;
    expect(ranAt - releasedAt).toBeLessThan(50);
    expect(store.guarantees.wait).toBe('wake');
    await store.dispose?.();
  });

  it('wakes a waiter within one backoff step when polling is forced, so the fallback is still prompt', async () => {
    const name = uniqueName('poll');
    const store = redisStore(client, { ttl: TTL_MS, wake: 'poll' });
    const locks = createLocks({ store, namespace: 'it' });
    const holder = await locks.mutex(name).acquire({ wait: '2s' });
    const waiter = locks.mutex(name).run(() => Date.now(), { wait: '10s' });
    await sleep(20);
    const releasedAt = Date.now();
    await holder.release();
    const ranAt = await waiter;
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
    const holder = await locks.mutex(name).acquire({ wait: '2s' });
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
    const holder = await locks.mutex(name).acquire({ wait: '2s' });
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
      expect(await locks.mutex(uniqueName('warm')).tryRun(() => 'warm')).toEqual({ ran: true, value: 'warm' });
      cutNextReply = true;
      expect(await locks.mutex(name).tryRun(() => 'ran')).toEqual({ ran: true, value: 'ran' });
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
    const holder = await locks.mutex(name).acquire({ wait: '2s' });
    const waiter = locks.mutex(name).run(() => Date.now(), { wait: '10s' });
    await eventually(() => store.guarantees.wait === 'wake' && prefixed.status === 'ready', 3000, 'the client');
    await sleep(100);
    const releasedAt = Date.now();
    await holder.release();
    const ranAt = await waiter;
    expect(ranAt - releasedAt).toBeLessThan(50);
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
