/** `KV` against a real Redis (testcontainers; needs Docker) and a real TLS socket. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:tls';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { RedisContainer } from '@testcontainers/redis';
import KeyvRedis from '@keyv/redis';
import { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { KvCloseFailed } from './errors.js';
import { KV } from './index.js';

let container: StartedRedisContainer;
let probe: Redis;
let url: string;
let counter = 0;
const fresh = (name: string) => `${name}-${++counter}-${Math.random().toString(36).slice(2)}`;
const closeCleanly = async (kv: KV) => expect(await kv.close()).toBeUndefined();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  url = container.getConnectionUrl();
  probe = new Redis(url);
}, 120_000);

afterAll(async () => {
  await probe.quit();
  await container.stop();
});

describe('setIfNotExists writes what set writes', () => {
  it('is read back by get, lives in the same Redis key as set, and expires', async () => {
    const kv = new KV(url, 'nx-ns');
    const key = fresh('nx');
    expect(await kv.setIfNotExists(key, { owner: 'a' }, 100)).toBe(true);
    expect(await kv.setIfNotExists(key, { owner: 'b' }, 100)).toBe(false);
    // Before the fix `get` saw nothing: NX wrote bare JSON under a different key than `set` uses.
    expect(await kv.get(key)).toEqual({ owner: 'a' });
    // `set` on the same key overwrites that one Redis entry instead of making a second one.
    await kv.set(key, { owner: 'c' }, 100);
    expect(await kv.get(key)).toEqual({ owner: 'c' });
    const stored = await probe.keys(`*${key}`);
    expect(stored).toHaveLength(1);
    expect(await probe.ttl(stored[0] ?? '')).toBeGreaterThan(0);
    await closeCleanly(kv);
  });

  it('works without a namespace', async () => {
    const kv = new KV(url);
    const key = fresh('nx-bare');
    expect(await kv.setIfNotExists(key, 'v', 100)).toBe(true);
    expect(await kv.get(key)).toBe('v');
    await closeCleanly(kv);
  });
});

describe('mset', () => {
  it('applies the expiry to every pair', async () => {
    const kv = new KV(url, 'mset-ns');
    const a = fresh('a');
    const b = fresh('b');
    await kv.mset(
      [
        [a, 1],
        [b, 2],
      ],
      100,
    );
    for (const key of [a, b]) {
      const [redisKey] = await probe.keys(`*${key}`);
      // Before the fix the TTL was dropped and every pair lived forever (ttl -1).
      expect(await probe.ttl(redisKey ?? '')).toBeGreaterThan(0);
    }
    expect(await kv.mget([a, b])).toEqual([1, 2]);
    await closeCleanly(kv);
  });

  it('stores pairs without an expiry when none is given', async () => {
    const kv = new KV(url, 'mset-ns');
    const key = fresh('forever');
    await kv.mset([[key, 1]]);
    const [redisKey] = await probe.keys(`*${key}`);
    expect(await probe.ttl(redisKey ?? '')).toBe(-1);
    await closeCleanly(kv);
  });
});

describe('close', () => {
  it('returns nothing when both connections close', async () => {
    const kv = new KV(url, 'close-ns');
    await kv.set(fresh('k'), 1);
    await closeCleanly(kv);
  });

  it('returns a KvCloseFailed failure, not a console line, when a disconnect fails', async () => {
    const kv = new KV(url, 'close-ns');
    await kv.set(fresh('k'), 1);
    // A refused disconnect cannot be provoked on a live connection, so it is injected.
    const refuse = vi.spyOn(KeyvRedis.prototype, 'disconnect').mockRejectedValueOnce(new Error('disconnect refused'));
    const closed = await kv.close();
    refuse.mockRestore();
    // Before the fix the failure went to console.error and close() resolved as if it had worked.
    expect(KvCloseFailed.is(closed)).toBe(true);
    expect(closed?.data).toEqual({ target: 'store', reason: 'disconnect refused' });
  });

  it('still closes the limiter connection when the store disconnect fails', async () => {
    const kv = new KV(url, 'close-ns');
    await kv.set(fresh('k'), 1);
    const refuse = vi.spyOn(KeyvRedis.prototype, 'disconnect').mockRejectedValueOnce(new Error('disconnect refused'));
    expect(await kv.close()).toBeDefined();
    refuse.mockRestore();
    // A second close finds the limiter connection already gone and has nothing left to fail on.
    expect(await kv.close()).toBeUndefined();
  });
});

describe('rate limiter degrade is visible and does not stick', () => {
  it('reports a memory limiter while Redis is not ready, then rebuilds it on Redis', async () => {
    const kv = new KV(url, 'rl-ns');
    const id = fresh('login');
    // Created at once: the Redis connection has not finished its handshake.
    const early = kv.getRateLimiter(id, { points: 3, duration: 60 });
    expect(early).toBeInstanceOf(RateLimiterMemory);
    expect(kv.degradedRateLimiters).toEqual([id]);

    for (let i = 0; i < 100 && kv.degradedRateLimiters.length > 0; i++) {
      await sleep(50);
      if (!(kv.getRateLimiter(id, { points: 3, duration: 60 }) instanceof RateLimiterMemory)) break;
    }
    // Before the fix the first (memory) limiter stayed cached forever and limits never became shared.
    const later = kv.getRateLimiter(id, { points: 3, duration: 60 });
    expect(later).toBeInstanceOf(RateLimiterRedis);
    expect(kv.degradedRateLimiters).toEqual([]);
    await closeCleanly(kv);
  });
});

describe('TLS certificate checking', () => {
  let port: number;
  let secureConnections = 0;
  let rejectedHandshakes = 0;
  let closeServer: () => void;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kv-tls-'));
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '1', '-subj', '/CN=localhost'],
      { cwd: dir, stdio: 'ignore' },
    );
    const server = createServer(
      { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) },
      socket => {
        secureConnections += 1;
        socket.on('error', () => {
          /* the client hangs up on purpose */
        });
        socket.destroy();
      },
    );
    server.on('tlsClientError', () => {
      rejectedHandshakes += 1;
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    closeServer = () => server.close();
  });

  afterAll(() => closeServer());

  it('refuses a self-signed certificate by default', async () => {
    secureConnections = 0;
    rejectedHandshakes = 0;
    const kv = new KV(`rediss://127.0.0.1:${port}`, 'tls');
    await sleep(1500);
    await closeCleanly(kv);
    // Before the fix every rediss:// URL skipped the check, so the handshake always completed.
    expect(secureConnections).toBe(0);
    expect(rejectedHandshakes).toBeGreaterThan(0);
  });

  it('completes the handshake only when allowUnverifiedTls is set by name', async () => {
    secureConnections = 0;
    const kv = new KV(`rediss://127.0.0.1:${port}`, 'tls', 'rl', { allowUnverifiedTls: true });
    await sleep(1500);
    await closeCleanly(kv);
    expect(secureConnections).toBeGreaterThan(0);
  });
});
