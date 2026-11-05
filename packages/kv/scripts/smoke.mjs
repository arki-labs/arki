// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`. No Redis is needed: the checks use an unreachable
// address, so every Redis answer is the typed failure, plus the in-process rate limiter.

import { Redis } from 'ioredis';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { isFailure } from '@arki/failure';

import { kv as kvPlugin } from '../dist/dot.js';
import { env } from '../dist/env.js';
import { KV_INITIALIZATION_ERROR_CODES, KVInitializationError } from '../dist/errors.js';
import { KV, KvUnavailable } from '../dist/index.js';
import { createKVInstance } from '../dist/instance.js';
import { redisResponseCache } from '../dist/redis/idempotency.js';

const DEAD_URL = 'redis://127.0.0.1:1';

const store = new KV(DEAD_URL, 'smoke', 'rl', { commandTimeoutMs: 500 });
const missing = await store.get('a', z.string());
const limiter = store.getRateLimiter('smoke-limit', { points: 2, duration: 60 });
const first = await limiter.consume('client');
const second = await limiter.consume('client');
const third = await limiter.consume('client').then(
  () => 'allowed',
  rejected => (rejected.remainingPoints === 0 ? 'blocked' : 'other'),
);
const closed = await store.close();

const redis = new Redis(DEAD_URL, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
redis.on('error', () => {});
const cache = redisResponseCache(redis, { prefix: 'smoke:' });
const badOwner = await cache.begin('key', 'fingerprint', 'owner\nwith newline');
const unreachable = await cache.begin('key', 'fingerprint', 'owner');
const badTtl = await cache.finish('key', 'owner', { status: 200, headers: [], body: '' }, 0);
redis.disconnect();

const optionalApp = await defineApp('kv-optional')
  .infra(kvPlugin.optional(() => ({})))
  .start();
const optionalValue = isFailure(optionalApp) ? optionalApp.code : optionalApp.services.kv;
if (!isFailure(optionalApp)) await optionalApp.dispose();
const requiredApp = await defineApp('kv-required')
  .infra(kvPlugin(() => ({})))
  .start();
let initError;
try {
  const { createKV } = await import('../dist/factory.js');
  createKV('smoke');
} catch (error) {
  initError = error;
}

const checks = [
  ['unreachable redis get returns kv.unavailable', KvUnavailable.is(missing), true],
  ['rate limiter falls back to memory and counts', `${first.remainingPoints},${second.remainingPoints}`, '1,0'],
  ['third consume is blocked', third, 'blocked'],
  ['close of a never-connected client returns no failure', closed, undefined],
  ['idempotency claim refuses an owner with a newline', badOwner?.code, 'http.idempotency_claim_unconfirmed'],
  [
    'idempotency claim on unreachable redis is unconfirmed, not thrown',
    unreachable?.code,
    'http.idempotency_claim_unconfirmed',
  ],
  ['idempotency finish refuses a zero ttl', badTtl?.code, 'http.idempotency_write_unconfirmed'],
  ['env default redis port', env.REDIS_PORT, 6379],
  ['createKVInstance without KV_URL gives null', createKVInstance('smoke'), null],
  [
    'createKV without KV_URL throws the init error',
    initError instanceof KVInitializationError && initError.code === KV_INITIALIZATION_ERROR_CODES.urlNotConfigured,
    true,
  ],
  ['optional dot plugin without a url publishes null', optionalValue, null],
  ['required dot plugin without a url fails the start', isFailure(requiredApp), true],
];

const runtime =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== 'undefined') globalThis.process.exit(0);
