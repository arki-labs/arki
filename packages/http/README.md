# @arki/http

Typed HTTP for ARKI — route contracts as data, zod-validated handlers,
request-scope derivers, SSE streaming, and deterministic OpenAPI
generation. Ships a DOT adapter (`@arki/http/dot`) whose `http()` driver
turns a composed app into a running server with correct drain-on-shutdown
semantics.

No decorators, no controller scanning, no runtime DI container. Contracts
are plain values; wiring is checked at compile time.

## The model

A route is split in two:

- **Contract** — pure data at module scope: method + path + zod schemas +
  a stable id. Registerable in the DOT manifest (sync `configure`),
  renderable as OpenAPI without booting, and the source of the handler's
  inferred signature.
- **Binding** — the handler, attached inside a plugin's `provides` factory (or `boot`) where the
  plugin's typed needs are already injected. Handlers close over real
  services; no service locator exists.

```ts
import { route, routes } from '@arki/http';
import { z } from 'zod';

export const listOrders = route.get('/orders', {
  id: 'orders.list',
  query: z.object({ status: z.enum(['open', 'shipped']).optional() }),
  output: z.array(Order),
});

export const createOrder = route.post('/orders', {
  id: 'orders.create',
  body: CreateOrder,
  output: Order,
});
```

Input validation (params/headers/query/body) happens before your handler runs;
output is validated against the contract on the way out. Input is decoded and output
(and every SSE event) is encoded, so a zod codec works both ways: with
`z.codec(z.iso.datetime(), z.date(), …)` your handler gets and returns a
`Date`, and the wire carries the ISO string. Failures serialize as a
coded envelope: `{ "error": { "code", "message", "remediation?", "docsUrl?", "data?" } }`.

### Params, headers and responses

The contract describes the whole request and response. Path `params` and
`headers` are zod objects, and `responses` lists the other statuses a handler
may answer with.

```ts
export const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  params: z.object({ id: OrderId }), // keys must match the :placeholders
  headers: z.object({ 'x-tenant': z.string() }), // lower-case names
  output: Order,
  responses: { 409: Conflict },
});

routes().bind(getOrder, async ({ params, headers }) => {
  const order = await db.orders.find(headers['x-tenant'], params.id); // params.id is an OrderId
  return order ?? reply(409, { reason: 'moved' }, { headers: { 'retry-after': '1' } });
});
```

- `params` must have exactly one key per placeholder. Without `params` you get
  `Record<name, string>`. One optional placeholder is allowed, as the last
  segment (`/orders/:id?`): its schema must accept a missing value, the route
  serves both `/orders` and `/orders/x`, and OpenAPI lists both paths.
- `headers` names are lower-case. Only the declared names are read from the
  request, so a strict schema works next to `host` and `accept`. A missing
  header is left out of the object. (`z.coerce.number()` turns a missing or
  empty value into `0`; write the schema to refuse that.)
- `params`, `headers`, `query` and `body` are decoded, in that order; the first
  failure answers `400` and the handler does not run. SSE routes take `params`
  and `headers` too.
- `reply(status, body, { headers? })` answers with a status listed in
  `responses`. The body is encoded with that status's schema. `responses` keys
  are integers from 200 to 599, never 204 or 304, and never 200 next to a schema
  `output`.
- **No `output` means 204.** The handler returns nothing and the route answers
  `204` with an empty body. Returning a value from such a handler is `E511`.
- **`output: raw()` is the only way to return a `Response`** (a redirect, a file,
  a stream, a handler that owns its error formats). The engine passes it
  through and never validates it. `raw({ contentType })` feeds OpenAPI, and
  `responses` may document the payload; both are documentation only. A
  `Response` without `raw()`, or a plain value from a `raw()` route, is `E510`.

### Returning failures

A contract lists the [`@arki/failure`](../failure) failures its handler may
return. The handler returns a failure like any value; the engine answers
with the failure's status and the same envelope (`code`, `message`,
`remediation`, `data`). The output schema never runs on a failure.

```ts
export const OrderNotFound = defineFailure('order.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no order {id}',
});

export const getOrder = route.get('/orders/:id', { id: 'orders.get', output: Order, failures: [OrderNotFound] });

routes().bind(getOrder, ({ params }) => usecases.find(params.id)); // Order | Failure<'order.not_found', …>
```

A handler that can return a failure the contract does not list is a compile
error. Add its definition to `failures`. `RouteFailure<typeof getOrder>` is
the union of the listed failures. Failure `data` is sent as plain JSON, so
its schema must be JSON-safe: a `Date` field fails `revive` on the client.

## Inside a DOT app

A feature declares its HTTP surface with `endpoints(build)`. The builder
runs once at boot with the feature's typed needs:

```ts
import { feature } from '@arki/dot/feature';
import { service } from '@arki/dot/plugin';
import { endpoints, routes } from '@arki/http';

export const orders = feature('orders', {
  needs: { db: service<Db>() },
  actions: [listOrders, createOrder], // manifest + OpenAPI metadata
  use: [
    endpoints(({ db }: { readonly db: Db }) =>
      routes()
        .bind(listOrders, async ({ query }) => db.orders.list(query))
        .bind(createOrder, async ({ body }, ctx) => db.orders.create(body, ctx.requestId)),
    ),
  ],
});
```

A `defineFeature` feature uses `endpoints(core, build, { contracts })` from
`@arki/http/dot`, in `.entrypoints(...)`. `build` gets what every entrypoint
of the feature gets — needs, private infra and `usecases` — typed from the
core, so the routes file needs no annotation and no runtime import of the
feature. `contracts` are the feature's manifest actions (a chain feature has no
`actions` list of its own):

```ts
// features/orders/entrypoints/routes.ts
import { routes } from '@arki/http';
import { endpoints } from '@arki/http/dot';

import type { core } from '../feature';

export const orderRoutes = (c: typeof core) =>
  endpoints(c, ({ usecases }) => routes().bind(listOrders, ({ query }) => usecases.list(query)), {
    contracts: [listOrders],
  });

// features/orders/feature.ts
export const orders = core.entrypoints(orderRoutes(core));
```

`http()` serves both forms from one route table, in mount order. (Same
routes, fewer places for them to hide.)

`http()` is a driving adapter: mount it with `.serve()`, after the
features. It serves the routes of every mounted feature, in mount order —
the app lists its features once:

```ts
import { defineApp, hookSignals } from '@arki/dot';
import { http } from '@arki/http/dot';

const app = await defineApp('shop-api')
  .use(db({ url: DATABASE_URL }))
  .features([orders, billing])
  .serve(http({ port: 3000 }))
  .start();

hookSignals(app);
```

A feature with no `endpoints()` slice is skipped. Mount `http()` with
`.serve()`, not `.use()`: under `.use()` it boots before the features, so
their routes do not exist yet and boot fails.

Route bundles published as plain token services (not by a feature) go in
`bundles`. Each token becomes a need, so the `.serve(http(...))` line fails
to typecheck when no earlier unit provides it. Bundles come first in the
route table, then feature routes:

```ts
export const AdminRoutes = token<RouteBundle>()('admin.routes');

defineApp('shop-api')
  .use(adminPlugin) // provides: { [AdminRoutes.key]: () => routes().bind(...) }
  .features([orders])
  .serve(http({ port: 3000, bundles: [AdminRoutes] }));
```

Because `.serve()` mounts after every feature, reverse-order `stop` halts
ingress FIRST: the server stops accepting, drains in-flight requests
(`drainTimeoutMs`, default 10 s, `ARKI_HTTP_E005` on overrun), and only
then do features tear down. `boot` builds the router without listening;
`start` listens; `dispose` severs remaining connections and releases the
port. A feature whose `routes` slice is not a route bundle fails boot with
`ARKI_HTTP_E010`.

The published `httpServer` service carries the composed
`fetch: (Request) => Promise<Response>` — also the unit-test seam: call
your whole app without a socket.

## Request scope — derivers, not containers

Per-request values are typed context keys derived by plain functions.
Derivers run in declaration order; each adds a key later handlers (and
later derivers) see typed. A deriver that throws `HttpError` is the whole
"guard" story:

```ts
import { derive, HttpError, HTTP_ERROR_CODES } from '@arki/http';

// inside a `provides` factory — `auth` is an injected singleton
const withPrincipal = derive('principal', async req => {
  const p = await auth.verify(req.headers.get('authorization'));
  if (!p) throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'missing or invalid credentials');
  return p;
});

routes()
  .derive(withPrincipal)
  .derive('db', (_req, ctx) => dbForTenant(ctx.principal.tenantId))
  .bind(listOrders, async (_input, ctx) => ctx.db.orders.list());
```

Request scope is function application over the compile-time-wired
singleton graph — no per-request container resolution, no infectious
scopes. For code deep in a call stack you don't control, the fenced-off
`@arki/http/context` entry exposes `requestContext()` (AsyncLocalStorage).
It is a last resort; prefer the explicit `ctx`.

## App-wide middleware

For cross-cutting concerns that must see or touch the raw
request/response — CORS, request logging — pass fetch-shaped middleware
to `http()` (first = outermost). A middleware that throws `HttpError`
short-circuits into the coded envelope:

```ts
http({ port: 3000, bundles: [OrdersRoutes], middleware: [requestLog(logger), cors(origins)] })
```

Middleware wraps the whole engine and is untyped by design; anything that
produces a per-request *value* belongs in a deriver instead. Standalone
users compose the same way with `composeMiddleware(engine.fetch, [...])`.

## Idempotency keys

`idempotent(...)` from `@arki/http/idempotency` is an `HttpMiddleware`. It runs each listed request once per `Idempotency-Key` and answers a repeat with the stored response. It is portable (Web Crypto only). The store is a `ResponseCache`: `@arki/journal/http` (Postgres) or `@arki/kv/redis/idempotency` (Redis).

```ts
import { idempotent } from '@arki/http/idempotency';
import { responseCache } from '@arki/journal/http';

http({
  middleware: [
    authenticate, // runs first: the principal in `scope` must already be trusted
    idempotent({
      cache: responseCache(db, tables),
      scope: req => principalOf(req)?.id, // undefined = unauthenticated: never cached, never replayed
      routes: ['POST /orders', 'POST /orders/:id/pay'], // include any mount prefix
      ttl: 24 * 60 * 60 * 1000, // milliseconds, counted from the first request
      replayHeaders: ['content-type', 'location'], // a replay carries only these
    }),
  ],
});
```

- The fingerprint is method + path + sorted query + a SHA-256 of the body. The cache key is the scope plus the header value.
- No header on a listed route: 400 (`ARKI_HTTP_E410`). Same key, different request: 422 (`E411`). Same key while the first is running: 409 with `Retry-After` (`E412`). A replay has the stored status and body, the allowlisted headers, and `Idempotent-Replayed: true`.
- **What is stored.** Every 2xx, 3xx and 4xx answer, except 409 and 429. A 5xx, a 409, a 429, a handler that throws, and an event stream free the key (`abandon`), so a retry runs the handler again. A 4xx is stored because the same request would fail the same way.
- **Size.** A response body over `maxBodyBytes` (default 1 MiB) is not stored: the key is freed. A request body over it cannot be fingerprinted cheaply, so that request runs with no idempotency at all. Raise the limit for routes that take big uploads, or keep them off `routes`.
- A failing cache fails the request. Running unprotected could do the work twice.
- This caches responses for HTTP replay. It is not the journal's command receipt, which commits with the business write. Use both for a payment: the cache answers a repeat cheaply, the receipt keeps a repeat that reaches the handler from writing twice.

## Webhooks

`@arki/http/webhooks` checks that a webhook comes from the sender who holds the secret. It is portable (Web Crypto only), and `subtle.verify` compares in constant time.

```ts
import { standardWebhooks, verifyWebhook } from '@arki/http/webhooks';

const partnerEvents = routes()
  .derive('webhook', verifyWebhook({ scheme: standardWebhooks({ secrets: [env.PARTNER_WEBHOOK_SECRET] }) }))
  .bind(orderShipped, async ({ body }, { webhook }) => {
    // The event id is the journal key: a resent event commits nothing the second time,
    // and the receipt commits with the write, so there is no separate "seen" table.
    await journal.run(db, recordShipment, body, meta, { idempotencyKey: `partner:${webhook.id}` });
  });
```

- **Schemes.** `standardWebhooks({ secrets })` ([Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,…`). `stripe({ secrets })` (`stripe-signature: t=…,v1=…`; the id is the event's `id`). `hmac({ secrets, header, headerPrefix?, algorithm?, encoding?, idHeader?, timestampHeader?, bodyPrefix? })` for the rest: GitHub is `{ header: 'x-hub-signature-256', headerPrefix: 'sha256=', idHeader: 'x-github-delivery' }`; Slack adds `timestampHeader: 'x-slack-request-timestamp'` and `` bodyPrefix: ({ timestamp }) => `v0:${timestamp}:` ``.
- **The deriver reads a clone of the body.** The route's `body` schema still parses the same bytes after the check. A body over `maxBodyBytes` (default 1 MiB) answers 413 before any check.
- **Rotation.** Pass several secrets, the new one first. Any one may match; `sign` uses the first.
- **Replays.** The signed time must be within `tolerance` seconds of now, either way (default 300). Only a signed time stops a replay, so with `hmac` put the time in `bodyPrefix`. Past the window, the journal key stops a resent event.
- **`webhook.id`** only ever comes from signed bytes, because it becomes the journal key. `standardWebhooks`: the signed `webhook-id`. `stripe`: the event's `id` in the body (`string | undefined`). `hmac`: the SHA-256 of the body, because those senders put their id in a header the signature does not cover (GitHub's `x-github-delivery`), and a resend under a forged id would otherwise run twice.
- Every scheme also has `verify({ headers, body })` for use outside a route, and `sign(body, { id?, timestamp? })` for senders and tests.
- Failures answer 401: headers missing or malformed (`E420`), no signature matches (`E421`), signed time outside the window (`E422`). A scheme with no secret, an empty one, or (Standard Webhooks) one that is not base64 throws `E012` when it is created.

## Streaming

**Typed SSE.** `route.sse` declares a `text/event-stream` contract; the
binding is an async generator. Every yield is validated against the event
schema and framed as a `data:` message; client disconnect aborts
`ctx.signal` and runs the generator's `finally`:

```ts
const progress = route.sse('/orders/:id/progress', {
  id: 'orders.progress',
  event: z.discriminatedUnion('type', [Queued, Shipped]),
  heartbeatMs: 15_000, // optional :keepalive comments
});

routes().bind(progress, async function* ({ params }, ctx) {
  for await (const step of tracker.watch(params.id, ctx.signal)) {
    yield step;
  }
});
```

**Raw streams.** Any handler may return a `Response` wrapping a
`ReadableStream` — file downloads, AI token streams. The engine is
fetch-native end to end.

## Mounting foreign handlers

An oRPC router, a tRPC fetch adapter, or any fetch-shaped handler mounts
as one manifest route — the migration on-ramp for existing backends:

```ts
routes().mount('/rpc', rpcHandler, { id: 'rpc', transport: 'orpc' });
```

## OpenAPI

```ts
import { toOpenApi } from '@arki/http';

const document = toOpenApi([listOrders, createOrder, progress], {
  title: 'shop-api',
  version: '1.0.0',
});
```

Deterministic — same contracts, byte-identical output. Path and header
parameters are typed from `params` and `headers`, every status in `responses`
is listed, a no-output route documents `204`, and a `raw()` route is marked
`x-arki-raw: true`. Schemas describe the wire form (`io: 'input'`), so a codec
shows its string side. Inside a DOT app,
contract actions put the JSON Schemas into the manifest, so
`dot explain --as openapi` renders the document from the static manifest
without booting anything.

## Typed client

`createClient` builds a fetch client from the same contracts the server binds.
Pass one contract for one call, or an object of contracts for one call per key:

```ts
import { createClient } from '@arki/http/client';

const orders = createClient({ listOrders, getOrder }, { baseUrl: 'https://api.example.com' });

const open = await orders.listOrders({ query: { status: 'open' } });
const order = await orders.getOrder({ params: { id: 'o42' } }, { headers: { authorization } });
```

- Input (`params`, `query`, `headers`, `body`) and output are typed from the
  contract. A wrong input does not compile.
- Params, headers, query and body are encoded with their schemas and the output
  is decoded, exactly mirroring the server, so codecs round-trip. A missing
  optional path segment is dropped from the URL.
- A status listed in `responses` resolves to that schema's decoded body.
- A non-2xx answer whose code is one of the contract's `failures` resolves to
  that failure, revived with `revive` from `@arki/failure`, so the call's type
  is `Output | the listed failures` and you can `match` on it. Data its
  definition rejects throws `E500`.
- Any other non-2xx answer throws `HttpError` with the server's `code`. An answer
  without the envelope gets a code by status (`E400`, `E401`, `E403`, `E404`,
  else `E500`). A body that breaks the output schema throws `E500`.
- A path param that is empty, `.` or `..` throws `E400` before sending: it
  would change which endpoint the URL points at.
- A contract with no `output` resolves `undefined` (it answers 204). One with `output: raw()` resolves the `Response`.
- It only needs `fetch`, so it runs in browsers, React Native, Deno, Bun and
  Node. Pass `fetch` to add auth. SSE contracts are not supported.

### Retries, timeouts, and calling URLs you do not control

```ts
import { backoff, createRetryPolicy } from '@arki/resilience';
import { createClient } from '@arki/http/client';
import { publicFetch } from '@arki/http/public-fetch';

const partner = createClient(partnerRoutes, {
  baseUrl: partnerUrl, // set by a user: it must not reach your private network
  fetch: publicFetch(),
  policy: createRetryPolicy({ backoff: backoff.exponential({ base: 200 }).upTo(3) }),
  timeoutMs: 10_000,
});
```

- **`policy`** runs each attempt; any `@arki/resilience` policy fits (one with a
  fallback does not: its result might not be a response). The client, not the
  policy, decides what is retried: only an outcome `retryOn` accepts goes back
  into the policy. Anything else leaves it at once, even if the policy would
  retry every error. When the policy gives up, the last answer is decoded as
  usual, so the server's error code still reaches you.
- **`retryOn`** defaults to `retryTransient`: a network failure (`fetch` throws a
  `TypeError`) or a 408, 429, 502, 503 or 504, and only on a request that is
  safe to send twice: GET, HEAD, OPTIONS, PUT, DELETE, or any request with an
  `idempotency-key` header. A POST without one is never retried, because the
  first try may have done the work before its answer was lost.
- **`timeoutMs`** covers the whole call, retries included, until the response
  arrives (reading the body is not timed). It throws `HttpError` 408
  (`E408`). A caller's `signal` still aborts with its own reason. It needs
  `AbortController`, which React Native provides and bare Hermes does not.
- **`publicFetch()`** (Node and Bun) is the SSRF guard as a `fetch`: each hop
  resolves the host, refuses a private answer, pins the connection to the
  checked address, and follows a redirect only to another public URL. It
  buffers the body (at most `maxBytes`, default 10 MB), so a streaming answer
  arrives whole.

## Without DOT

The core is framework-agnostic:

```ts
import { buildEngine, listen, routes } from '@arki/http';

const engine = buildEngine([bundle]);
const handle = await listen(engine.fetch, { port: 3000 });
```

`listen` uses `Bun.serve` under Bun and `@hono/node-server` under Node.
Routing is Hono internally; no Hono type appears in the public API.

## Error codes

Stable API — match on codes, never parse messages.

| Code | Meaning |
| --- | --- |
| `ARKI_HTTP_E001` | `start` could not bind the port |
| `ARKI_HTTP_E002` | duplicate route: two bindings claim the same method+path (or a bundle token is listed twice) |
| `ARKI_HTTP_E005` | `stop` exceeded `drainTimeoutMs` with requests in flight |
| `ARKI_HTTP_E006` | malformed mount path |
| `ARKI_HTTP_E007` | deriver key duplicates an earlier deriver or a base context key |
| `ARKI_HTTP_E008` | a bundle token's service was missing at boot (erased composition only) |
| `ARKI_HTTP_E011` | a route contract is inconsistent (params vs path, headers, responses). Thrown by `route.*()` |
| `ARKI_HTTP_E012` | a webhook scheme has no secret, an empty one, or one it cannot decode. Thrown when the scheme is created |
| `ARKI_HTTP_E400` | request validation failed (params/headers/query/body) or body is not valid JSON |
| `ARKI_HTTP_E401` / `E403` | credential / permission rejection (thrown by your derivers) |
| `ARKI_HTTP_E404` | no route matches |
| `ARKI_HTTP_E408` | a client call got no response within `timeoutMs` (thrown by `@arki/http/client`, never sent on the wire) |
| `ARKI_HTTP_E410` / `E411` / `E412` | idempotency: key missing (400), key reused for another request (422), request with this key still running (409) |
| `ARKI_HTTP_E413` | request body larger than the route allows (413) |
| `ARKI_HTTP_E420` / `E421` / `E422` | webhook: signature headers missing or malformed, no signature matches, signed time outside the window (all 401) |
| `ARKI_HTTP_E500` | handler crash or output-schema violation |
| `ARKI_HTTP_E510` | a `Response` without `output: raw()`, or a plain value from a `raw()` route (answers 500) |
| `ARKI_HTTP_E511` | a result that does not fit the contract: undeclared `reply` status, or a value on a no-output route (answers 500) |

`E0NN` codes surface through the DOT lifecycle into `app.diagnostics`;
`E4xx`/`E5xx` codes surface on the wire in the error envelope (`E510` and
`E511` answer 500). Unexpected
error messages are redacted when `NODE_ENV=production`.

<!-- bench:start -->
## Benchmarks

Each router receives a real `Request` and returns a `Response`, in process, with no network. `@arki/http` is built on hono, so hono is the direct reference; itty-router is the small, hand-wired alternative. All three serve the same 20 routes and validate bodies with the same zod schema.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Static GET (one of 20 routes)

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/http (route contracts) | 46.83 µs | 1.41× |
| hono (+ @hono/zod-validator for bodies) | 33.17 µs | fastest |
| itty-router v5 (hand-written validation) | 35.46 µs | 1.07× |

### GET with a path parameter

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/http (route contracts) | 28.75 µs | 1.33× |
| hono (+ @hono/zod-validator for bodies) | 21.54 µs | fastest |
| itty-router v5 (hand-written validation) | 26.25 µs | 1.22× |

### POST with a valid JSON body

Body parsed and checked with the same zod schema in all three. `@arki/http` also checks the output.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/http (route contracts) | 40.54 µs | 1.12× |
| hono (+ @hono/zod-validator for bodies) | 36.54 µs | 1.01× |
| itty-router v5 (hand-written validation) | 36.21 µs | fastest |

### POST with an invalid body (400)

The failure path. `@arki/http` builds its typed error envelope; hono returns its validator error; itty returns a hand-written JSON error.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/http (route contracts) | 55.17 µs | 1.23× |
| hono (+ @hono/zod-validator for bodies) | 53.08 µs | 1.18× |
| itty-router v5 (hand-written validation) | 44.96 µs | fastest |

Read the rows with the contracts in mind:

- `@arki/http` runs on hono. The gap to plain hono is the price of the contract layer: every handler input (params, query, body) is validated against its contract, and every handler output is validated against the contract output schema, so a wrong response fails loudly instead of leaving the process.
- The hono and itty-router rows do not validate handler output and have no route ids, no error envelope and no OpenAPI generation. Their `Request` and `Response` work is the same.
- itty-router has no validation hook, so its rows parse the JSON and run the zod schema by hand, the way its docs suggest.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT
