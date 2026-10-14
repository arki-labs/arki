# @arki/kv

Key-value store abstraction with pluggable adapters for ARKI. Wraps [Keyv](https://keyv.org/) for general key-value access and [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) for Redis-backed rate limiting. Provides automatic TLS handling (via `rediss://` URLs), Upstash support, and a graceful in-memory fallback when Redis is unreachable.

## Installation

```sh
npm install @arki/kv
# or
bun add @arki/kv
# or
pnpm add @arki/kv
```

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

## API

- `@arki/kv`
  - `KV` — Redis-backed key-value + rate-limiter client.
  - `createKV(namespace?, rateLimitPrefix?)` — env-driven KV factory.
  - `createRateLimitKV(namespace?)` — env-driven KV factory tuned for rate limiting.
- `@arki/kv/env` — `env` object holding the validated KV/Redis env vars.
- `@arki/kv/errors` — `RateLimitExceededError` with HTTP-header helpers.
- `@arki/kv/instance` — `initializeKV`, `createKVInstance` lazy-singleton helpers.

## Environment variables

| Variable                  | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `KV_URL`                  | Primary Redis/Keyv URL (use `rediss://` TLS). |
| `KV_NAMESPACE`            | Optional default namespace for keys.          |
| `RATE_LIMIT_REDIS_URL`    | Dedicated Redis URL for rate limiting.        |
| `RATE_LIMIT_PREFIX`       | Prefix for rate-limit keys (default `rl`).    |
| `CACHE_TTL_DEFAULT`       | Default TTL in seconds (default `3600`).      |

## Documentation

`@arki/kv` ships an optional `@arki/kv/dot` adapter for the
[`@arki/dot`](https://www.npmjs.com/package/@arki/dot) framework.

- See `packages/dot/docs/` in the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
  package for plugin authoring, lifecycle, diagnostics, and the
  [adapter authoring guide](https://github.com/arkijs/arki/blob/main/packages/dot/docs/adapter-authoring.md).

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
