# @arki/kv

Key-value store abstraction with pluggable adapters for ARKI. Wraps [Keyv](https://keyv.org/) for general key-value access and [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) for Redis-backed rate limiting. Provides automatic TLS handling (via `rediss://` URLs), Upstash support, and a graceful in-memory fallback when Redis is unreachable.

## Install

```sh
npm install @arki/kv
# or
bun add @arki/kv
# or
pnpm add @arki/kv
```

## Quick start

Open a store, write a value with a TTL, read it back, and close.

```ts
import { KV } from '@arki/kv';

export async function demo(): Promise<string | undefined> {
  const kv = new KV('redis://localhost:6379', 'my-app');
  await kv.set('hello', 'world', 60); // 60-second TTL
  const value = await kv.get<string>('hello');
  await kv.close();
  return value; // 'world'
}
```

This needs a Redis at that URL, so the block is compiled and not run. In an app, read the URL from `KV_URL` with `createKV('my-app')`.

## When not to use this

- You need a store that is not Redis. The adapter is Redis through Keyv. There is no other backend.
- You need a durable database. Keys expire and Redis can lose data. Keep records of truth in Postgres.
- You need strict global rate limits when Redis is down. The limiter falls back to memory, per process. Limits are then per instance.
- You need transactions across keys. `KV` is get, set and delete, with a TTL.
- You need pub/sub or queues. Use a queue library.

## Runtime support

Node and Bun on a server. The client uses `ioredis` and `@keyv/redis`, which need sockets. It does not run in a browser, Deno or Hermes. `@arki/kv/errors` has no Redis import. `RateLimitExceededError` can be matched anywhere.

## Usage

### `KV` — direct construction

```ts
import { KV } from '@arki/kv';

const kv = new KV('redis://localhost:6379', 'my-app');

await kv.set('hello', 'world', 60); // 60-second TTL
const value = await kv.get('hello'); // 'world'
await kv.delete('hello');

await kv.close();
```

### `createKV` / `createKVInstance` — env-driven factories

```ts
import { createKV } from '@arki/kv';
import { createKVInstance } from '@arki/kv/instance';

// Reads KV_URL from process.env, throws if missing.
const kv = createKV('my-app');

// Returns null in development if KV_URL is missing (no throw); exits in production.
const kvOrNull = createKVInstance('my-app');
```

### Rate limiting

```ts
import { createKV } from '@arki/kv';
import { RateLimitExceededError } from '@arki/kv/errors';

const kv = createKV('my-app');
const userId = 'usr_1';
const limiter = kv.getRateLimiter('login', { points: 5, duration: 60 });

try {
  await limiter.consume(userId);
} catch (cause) {
  if (cause instanceof RateLimitExceededError) {
    // 429 + Retry-After headers from `cause.getHttpHeaders(5)`.
  }
}
```

When the rate-limiter Redis client is not ready, the limiter transparently falls back to an in-memory implementation — your code keeps working, persistence is briefly lost.

## Idempotency response cache (Redis)

`@arki/kv/redis/idempotency` stores replayable HTTP responses for the `idempotent()` middleware of `@arki/http/idempotency`. It uses the `ioredis` client you already have.

```ts
import { Redis } from 'ioredis';

import { route } from '@arki/http';
import { IDEMPOTENCY_FAILURES, idempotent } from '@arki/http/idempotency';
import { redisResponseCache } from '@arki/kv/redis/idempotency';

const redis = new Redis(process.env.KV_URL ?? 'redis://localhost:6379');
const scope = (): string => 'tenant-1';

idempotent({ cache: redisResponseCache(redis), scope, routes: [route.post('/orders', { id: 'orders.create', failures: IDEMPOTENCY_FAILURES })], ttl: 86_400_000 });
```

`begin` uses `SET key value NX` without expiry. Pending reservations persist until the application reconciles them. `finish` checks the owner and atomically writes the response with `PX ttl`, starting replay retention then. A missing or different owner returns `IdempotencyOwnershipLost`; Redis rejection returns the operation's unconfirmed failure with a private cause. Invalid replay data returns `IdempotencyReplayInvalid`. `abandon` releases only a pending reservation owned by the caller, after reconciliation proves repetition safe. Keys use `idem:` unless you pass `{ prefix }`. `@arki/http` is an optional peer.

Upgrade with all old writers stopped: drain active requests, inventory legacy pending keys, reconcile their application outcomes, and `PERSIST` unresolved keys before reopening traffic. Do not delete a pending key merely because its old TTL elapsed. Mixed writer versions are unsafe because old writers can expire unresolved reservations. Use durable Redis persistence and an eviction policy that preserves reservations; store loss still needs durable application receipts to prevent duplicate business work.

## Environment variables

| Variable                  | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `KV_URL`                  | Primary Redis/Keyv URL (use `rediss://` TLS). |
| `KV_NAMESPACE`            | Optional default namespace for keys.          |
| `RATE_LIMIT_REDIS_URL`    | Dedicated Redis URL for rate limiting.        |
| `RATE_LIMIT_PREFIX`       | Prefix for rate-limit keys (default `rl`).    |
| `CACHE_TTL_DEFAULT`       | Default TTL in seconds (default `3600`).      |

## Public imports

| Import | What it holds |
| --- | --- |
| `@arki/kv` | `KV`, `createKV`, `createRateLimitKV` |
| `@arki/kv/env` | `env`, the validated variables |
| `@arki/kv/errors` | `RateLimitExceededError`, `KV_INITIALIZATION_ERROR_CODES`, `KVInitializationError` |
| `@arki/kv/instance` | `initializeKV`, `createKVInstance` |
| `@arki/kv/redis/idempotency` | `redisResponseCache`, the response cache for `@arki/http/idempotency` |
| `@arki/kv/dot` | `kv()`, `kv.optional()`, the Dot unit |

## Failure behaviour

- A rate limit hit throws `RateLimitExceededError`. Answer 429 and send `cause.getHttpHeaders(points)`.
- A missing URL: `createKV` throws. `createKVInstance` returns `null` in development and throws a `KVInitializationError` in production. Match on `error.code` (`KV_INIT_E001` to `KV_INIT_E003`).
- The Dot unit fails boot with `ARKI_KV_PLUGIN_E001` (no URL) or `ARKI_KV_PLUGIN_E002` (the probe failed).
- If the rate-limiter Redis client is not ready, the limiter uses memory instead of throwing. Your code keeps working. Persistence is briefly lost.
- `get` returns `undefined` for a missing or expired key. It does not throw.

Never match on the message.

## Limits

- **TTL units.** `set(key, value, ttl)` takes seconds. The idempotency cache takes milliseconds (`ttl: 86_400_000`).
- **Rate-limit fallback.** In memory, per process. With 3 instances and 5 points per minute, a user can make up to 15 attempts while Redis is down.
- **Idempotency cache.** Needs Redis 6 or newer (`KEEPTTL`). The TTL counts from `begin`.
- **Lookup cost.** `getRateLimiter(id, options)` builds a cache key by serialising the options on every call. Hold the limiter if the call is hot.
- **Probe.** `probe: true` gives up after `probeTimeoutMs` (default 5000).
- **Values.** Values go through Keyv serialisation. Store JSON-safe data.

## Documentation

`@arki/kv` ships an optional `@arki/kv/dot` adapter for the
[`@arki/dot`](https://www.npmjs.com/package/@arki/dot) framework.

- The unit publishes `kv` through `provides`. Consumers write
  `needs: { kv: kvInfra.provides.kv }`; `.lazy` on the handle gives a `Lazy<T>`.
- `kv()` fails boot without a URL (`ARKI_KV_PLUGIN_E001`).

### Optional KV: `kv.optional()`

For an app that runs without Redis in dev or tests. It takes the same options
as `kv()` and publishes `kv` as `KV | null`:

- No URL (`options.url` unset or empty, and no `KV_URL`): `kv` is `null` and
  no client is opened. Consumers handle `null` — a rate limiter allows every
  request, a cache misses.
- A URL: the same client `kv()` opens. `dispose` closes it.

```ts
import type { Provided } from '@arki/dot/unit';
import { kv } from '@arki/kv/dot';

const env = { KV_URL: process.env.KV_URL };

export const cache = kv.optional(() => ({ url: env.KV_URL, namespace: 'my-app', probe: true }));
export type Kv = Provided<typeof cache.provides.kv>; // KV | null
```

To make a missing URL fatal in production only, throw from the thunk:
`kv.optional(() => { if (isProd && !env.KV_URL) throw new Error('KV_URL is required'); return { url: env.KV_URL }; })`.

### Connection probe (both variants)

`probe: true` runs a set/get/delete round trip at boot. A bad or unreachable
URL then fails boot with `ARKI_KV_PLUGIN_E002` instead of failing the first
request. An unreachable Redis never answers, so the probe gives up after
`probeTimeoutMs` (default `5000`) and closes the client. Off by default.

- See `packages/dot/docs/` in the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
  package for unit authoring, lifecycle, diagnostics, and the
  [adapter authoring guide](https://github.com/arkijs/arki/blob/main/packages/dot/docs/adapter-authoring.md).

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, the Redis version and the error `code`.

<!-- bench:start -->
## Benchmarks

Only the rate limiter is benchmarked, against `rate-limiter-flexible`, the library `@arki/kv` wraps. `@arki/kv` talks only to Redis, so its get/set path needs a server and is not measured here. While it cannot reach Redis, `getRateLimiter()` returns an in-memory limiter, and that is what runs below.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### consume on a limiter you already hold

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/kv getRateLimiter() result, held once | 500.0 ns | 1.50× |
| rate-limiter-flexible RateLimiterMemory (used directly) | 333.0 ns | fastest |

### Look the limiter up on every request, then consume

How the API reads when you call it inline in a request handler.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/kv kv.getRateLimiter(id, options).consume(key) | 708.0 ns | 2.13× |
| Map<id, RateLimiterMemory> lookup, then consume | 333.0 ns | fastest |

Read the rows with the contracts in mind:

- The Redis client in this benchmark points at a closed local port. Nothing is listening and nothing leaves the machine. This measures the in-memory fallback, not the Redis-backed limiter that production uses, whose cost is dominated by the network round trip.
- The limiter allows 1,000,000,000 points, so no call is rejected and every `consume` takes the success path.
- Holding the limiter and calling `consume` runs the same `rate-limiter-flexible` code as using it directly, so those two rows should match within noise. The only difference is the lookup row: `getRateLimiter(id, options)` builds a cache key by serialising the options to JSON on every call.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT — see [LICENSE](./LICENSE).
