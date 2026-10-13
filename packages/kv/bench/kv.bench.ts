// Speed of the rate limiter in @arki/kv against rate-limiter-flexible.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Scope: @arki/kv is Redis-only. `new KV(url)` always creates a Keyv Redis store and an ioredis client,
// so its get/set path cannot run without a server and is NOT measured. The rate limiter can: while the
// ioredis client is not connected, `getRateLimiter()` returns a `RateLimiterMemory`. This suite points
// the client at a closed local port (nothing is listening, no traffic leaves the machine) to get that
// in-memory limiter, then times it.

import type { RateLimiterRes } from 'rate-limiter-flexible';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { compare, defineSuite } from '@arki/bench';
import { KV } from '@arki/kv';

// The KV constructor logs, and Keyv reports every failed reconnect. Silence both for the run.
const { log } = console;
console.log =
  console.warn =
  console.error =
    () => {
      /* silence rival libraries' console noise while timing */
    };

const kv = new KV('redis://127.0.0.1:1', 'bench', 'rl');
const options = { points: 1_000_000_000, duration: 60 };
// Each case uses its own limiter id, so no two cases share a counter.
const held = kv.getRateLimiter('held', options);
console.log = log;

if (!(held instanceof RateLimiterMemory)) {
  throw new TypeError('Expected an in-memory limiter while Redis is unreachable.');
}

const direct = new RateLimiterMemory({ keyPrefix: 'bench:rl:direct', ...options });
const byId = new Map([['lookup', new RateLimiterMemory({ keyPrefix: 'bench:rl:lookup', ...options })]]);

/** Distinct keys, each consumed for the first time by the contract check. */
const keys: readonly string[] = ['user-1', 'user-2', 'user-3', 'user-ăîșț', 'user-with:colon'];

const state = (result: RateLimiterRes): string => `${result.remainingPoints}/${result.consumedPoints}`;
const firstConsume = (): string => `${options.points - 1}/1`;

export default defineSuite({
  id: '@arki/kv',
  intro:
    'Only the rate limiter is benchmarked, against `rate-limiter-flexible`, the library `@arki/kv` wraps. `@arki/kv` talks only to Redis, so its get/set path needs a server and is not measured here. While it cannot reach Redis, `getRateLimiter()` returns an in-memory limiter, and that is what runs below.',
  notes: [
    'The Redis client in this benchmark points at a closed local port. Nothing is listening and nothing leaves the machine. This measures the in-memory fallback, not the Redis-backed limiter that production uses, whose cost is dominated by the network round trip.',
    'The limiter allows 1,000,000,000 points, so no call is rejected and every `consume` takes the success path. Rejection (the limiter running out of points) is not measured.',
    'Holding the limiter and calling `consume` runs the same `rate-limiter-flexible` code as using it directly, so those two rows should match within noise. The only difference is the lookup row: `getRateLimiter(id, options)` builds a cache key by serialising the options to JSON on every call.',
    'The contract check consumes each key once on a fresh limiter, so every case must report 999,999,999 points left after consuming 1.',
  ],
  groups: [
    compare<string>({
      id: 'consume-held',
      title: 'consume on a limiter you already hold',
      mode: 'async',
      contract: {
        id: 'kv-consume-held/v1',
        description: 'a first consume of a key that succeeds, with 999,999,999 of 1,000,000,000 points left',
      },
      inputs: keys,
      expected: firstConsume,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/kv getRateLimiter() result, held once',
          package: '@arki/kv',
          run: key => held.consume(key),
          normalize: state,
        }),
        direct: c({
          label: 'rate-limiter-flexible RateLimiterMemory (used directly)',
          package: 'rate-limiter-flexible',
          run: key => direct.consume(key),
          normalize: state,
        }),
      }),
    }),
    compare<string>({
      id: 'consume-lookup',
      title: 'Look the limiter up on every request, then consume',
      note: 'How the API reads when you call it inline in a request handler.',
      mode: 'async',
      contract: {
        id: 'kv-consume-lookup/v1',
        description: 'a first consume of a key that succeeds, with 999,999,999 of 1,000,000,000 points left',
      },
      inputs: keys,
      expected: firstConsume,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/kv kv.getRateLimiter(id, options).consume(key)',
          package: '@arki/kv',
          run: key => kv.getRateLimiter('lookup', options).consume(key),
          normalize: state,
        }),
        map: c({
          label: 'Map<id, RateLimiterMemory> lookup, then consume',
          package: 'rate-limiter-flexible',
          run: key => {
            const limiter = byId.get('lookup');
            if (!limiter) throw new Error('missing limiter');
            return limiter.consume(key);
          },
          normalize: state,
        }),
      }),
    }),
  ],
});
