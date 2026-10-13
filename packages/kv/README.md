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

## License

MIT — see [LICENSE](./LICENSE).
