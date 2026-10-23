# Agent guide: @arki/kv

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/index.ts` and `src/dot.ts` win.

## The model

1. `KV` wraps Keyv on Redis for get, set and delete with a TTL. It also builds rate limiters on `rate-limiter-flexible`.
2. `createKV(namespace)` reads `KV_URL` and throws without it. `createKVInstance(namespace)` returns `null` in development and fails in production.
3. If the rate-limiter Redis client is not ready, the limiter falls back to memory, per process.
4. `@arki/kv/redis/idempotency` is the Redis store for the `idempotent()` middleware of `@arki/http`.
5. `@arki/kv/dot` is the Dot unit. It publishes `kv` and closes the client on dispose.
6. It is not a database. Keys expire and Redis can lose data.

## Task map

### Store a value with a TTL

1. `const kv = createKV('pizzeria')`.
2. `await kv.set('key', value, 60)`. The TTL is in seconds.
3. `await kv.get<T>('key')` returns `undefined` when the key is missing or expired.

### Rate limit an action

1. `const limiter = kv.getRateLimiter('login', { points: 5, duration: 60 })`. Hold the limiter. Do not rebuild it per call.
2. `await limiter.consume(userId)` inside a `try`.
3. On `RateLimitExceededError`, answer 429 with `cause.getHttpHeaders(5)`.

### Use Redis for idempotency keys

1. Create an `ioredis` client.
2. `idempotent({ cache: redisResponseCache(redis), scope, routes: ['POST /orders'], ttl: 86_400_000 })`. The TTL is in milliseconds.
3. Pending reservations never expire. Replay TTL starts at confirmed `finish`. Release only after reconciliation proves repetition safe.
4. Stop old writers and drain/reconcile legacy pending keys before upgrading; preserve unresolved keys with `PERSIST`. Mixed writer versions are unsafe. See README for failure outcomes and store-loss limits.

### Run an app without Redis in dev

1. Use `kv.optional(() => ({ url: env.KV_URL }))` from `@arki/kv/dot`. The handle type is `KV | null`.
2. Handle `null` in every consumer. A limiter that gets `null` allows every request.

### Catch a bad URL at boot

1. Pass `probe: true`. Boot then fails with `ARKI_KV_PLUGIN_E002` instead of the first request failing.

## Rules that bite

- `set` takes seconds. The idempotency cache takes milliseconds.
- The memory fallback is per process. It does not share counts between instances.
- Hold the limiter returned by `getRateLimiter`. Each call serialises the options.
- `kv.optional()` can give `null`. Never assume a store exists in a consumer.
- Match on `error.code`, never on the message.
- Use `rediss://` for TLS.

## Errors

| Code                  | Meaning                                         | What to do                                        |
| --------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `ARKI_KV_PLUGIN_E001` | `kv()` booted without a URL.                    | Set `KV_URL`, pass `url`, or use `kv.optional()`. |
| `ARKI_KV_PLUGIN_E002` | The boot probe failed.                          | Check the URL, network and credentials.           |
| `KV_INIT_E001`        | Production started without `KV_URL`.            | Set `KV_URL`.                                     |
| `KV_INIT_E002`        | The store refused the connection in production. | Check the URL and credentials.                    |
| `KV_INIT_E003`        | Creating the client threw in production.        | Read the error `cause`.                           |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```

In an app that mounts the unit: the static graph, then the booted app's health.

```sh
dot explain --json | jq '.data'
dot doctor --json | jq '.data'
```

`dot explain` reads the manifest and starts nothing. `dot doctor` boots the app and disposes it.
