# @arki/http

Typed HTTP for ARKI — route contracts as data, handlers validated by any
Standard Schema (zod, valibot, arktype, your own),
request-scope derivers, SSE streaming, and deterministic OpenAPI
generation. Ships a DOT adapter (`@arki/http/dot`) whose `http()` driver
turns a composed app into a running server with correct drain-on-shutdown
semantics.

No decorators, no controller scanning, no runtime DI container. Contracts
are plain values; wiring is checked at compile time.

## Install

```sh
bun add @arki/http
# or
npm install @arki/http
```

Dependencies: `zod`, `hono`, `@hono/node-server`. `@arki/http/dot` has the peer `@arki/dot`. Install it only for the Dot adapter.

## Quick start

Declare a route, bind a handler, and call the engine. There is no socket in this example.

```ts run expect
import { buildEngine, route, routes } from '@arki/http';
import { z } from 'zod';

const Order = z.object({ id: z.string(), total: z.number() });

const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  params: { id: z.string() },
  output: Order,
});

const engine = buildEngine([routes().bind(getOrder, ({ params }) => ({ id: params.id, total: 12 }))]);

const response = await engine.fetch(new Request('http://localhost/orders/ord_1'));
console.log(response.status);
console.log(JSON.stringify(await response.json()));
```

```text
200
{"id":"ord_1","total":12}
```

To serve it, pass `engine.fetch` to `listen`. See [Without DOT](#without-dot).

## When not to use this

- You want decorators, controller scanning or a runtime DI container. Routes here are plain values.
- You need a schema library that is not Standard Schema. Any Standard Schema works. Others do not.
- You need GraphQL, gRPC or WebSockets. This package serves HTTP request and response, and SSE.
- You want to expose a database to the browser. Handlers validate input, but access rules are yours to write.
- Your app already has oRPC contracts. Use oRPC for those procedures. Mount it here with [Mounting foreign handlers](#mounting-foreign-handlers).

## Runtime support

| Entry | Node | Bun | Deno | Browser | Hermes |
| --- | --- | --- | --- | --- | --- |
| `@arki/http/client` | yes | yes | yes | yes | yes (needs `AbortController` and `fetch`) |
| `@arki/http` (server) | yes | yes | no | no | no |
| `@arki/http/dot` | yes | yes | no | no | no |

`listen` uses `Bun.serve` under Bun and `@hono/node-server` under Node. The server entry loads `node:async_hooks`. `bun run test:runtimes` runs the client smoke test on every runtime, and `scripts/server-smoke.mjs` runs the engine on Node and Bun.

## The model

A route is split in two:

- **Contract** — pure data at module scope: method + path + Standard Schemas +
  a stable id. Registerable in the DOT manifest (sync `configure`),
  renderable as OpenAPI without booting, and the source of the handler's
  inferred signature.
- **Binding** — the handler, attached inside a plugin's `provides` factory (or `boot`) where the
  plugin's typed needs are already injected. Handlers close over real
  services; no service locator exists.

App-shaped blocks import their schemas, contracts, services and plugins from [the docs fixture](docs/examples/fixture.ts): a small orders app (`Order`, `listOrders`, `db`, `auth`, a `defineFeature` core, and so on).

```ts
import { optional, route, routes } from '@arki/http';
import { z } from 'zod';

import { CreateOrder, Order } from './fixture.ts';

export const listOrders = route.get('/orders', {
  id: 'orders.list',
  query: { status: optional(z.enum(['open', 'shipped'])) },
  output: z.array(Order),
});

export const createOrder = route.post('/orders', {
  id: 'orders.create',
  body: CreateOrder,
  output: Order,
});
```

Input validation (params/headers/query/body) happens before your handler runs;
output is validated against the contract on the way out. Any schema that
implements [Standard Schema](https://standardschema.dev) works; an async one
too. Output is only as narrow as its schema: zod and valibot objects drop
keys they do not declare, an arktype object keeps them unless it declares
`'+': 'delete'`. A handler that returns a whole database row needs a schema
that drops undeclared keys, or must pick the fields itself. Failures
serialize as a coded envelope:
`{ "error": { "code", "message", "remediation?", "docsUrl?", "data?" } }`.

### Wire forms: a bare schema, or `codec(decode, encode)`

A bare schema means the wire form is the value form: the server decodes what
arrives with it and encodes what leaves with it. When the forms differ, pair
two schemas with `codec`. `decode` reads the wire, `encode` writes it, and the
pair must reverse each other's types or the call does not compile:

```ts
import { codec, route } from '@arki/http';
import { z } from 'zod';

const isoDate = codec(
  z.iso.datetime().transform(text => new Date(text)), // wire -> value
  z.date().transform(date => date.toISOString()), // value -> wire
);
const Shift = codec(z.object({ at: isoDate.decode }), z.object({ at: isoDate.encode }));

export const shift = route.post('/shift', { id: 'shift', query: { at: isoDate }, body: Shift, output: Shift });
// handler: query.at and body.at are Dates; the wire carries ISO strings both ways.
```

Request fields and the body run `decode`; `output`, `responses`, SSE events
and the typed client's inputs run `encode`. A zod `z.codec` inside a bare
schema only decodes (Standard Schema has no encode direction), so give a
two-way field a `codec()`.

### Params, headers and responses

The contract describes the whole request and response. `params`, `headers`
and `query` are records with one field per key: a schema, a `codec()`, or
`optional(...)` around either. `responses` lists the other statuses a handler
may answer with.

```ts run
import { buildEngine, optional, reply, route, routes } from '@arki/http';
import { z } from 'zod';

import { Conflict, Order, OrderId, db } from './fixture.ts';

export const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  params: { id: OrderId }, // keys must match the :placeholders
  headers: { 'x-tenant': z.string() }, // lower-case names
  query: { expand: optional(z.enum(['items'])) }, // may be left out
  output: Order,
  responses: { 409: Conflict },
});

const orderRoutes = routes().bind(getOrder, async ({ params, headers }) => {
  const order = await db.orders.find(headers['x-tenant'], params.id); // params.id is an OrderId
  return order ?? reply(409, { reason: 'moved' }, { headers: { 'retry-after': '1' } });
});
```

Call it with a request. An unknown order answers the `409` the contract lists:

```ts continue
const moved = await buildEngine([orderRoutes]).fetch(
  new Request('http://local/orders/o99', { headers: { 'x-tenant': 't1' } }),
);
if (moved.status !== 409 || moved.headers.get('retry-after') !== '1') throw new Error(`got ${moved.status}`);
```

- Each field schema gets one string, or `undefined` when the key is missing.
  A field marked `optional(...)` may be missing: the handler sees `undefined`,
  the key is typed `?:`, and its schema does not run. Any other missing field
  runs its schema with `undefined`, which usually fails. Multi-valued query keys
  give their last value. (`z.coerce.number()` turns an empty value into `0`;
  write the schema to refuse that.)
- `params` must have exactly one key per placeholder. Without `params` you get
  `Record<name, string>`. One optional placeholder is allowed, as the last
  segment (`/orders/:id?`): its field must be `optional(...)` (and an
  `optional(...)` param needs a `?` placeholder), the route serves both
  `/orders` and `/orders/x`, and OpenAPI lists both paths.
- `headers` names are lower-case. Only the declared names are read from the
  request, so transport headers (`host`, `accept`) never reach a schema.
- Every field, then the body, is decoded; all their issues answer one `400`
  (`request validation failed: query.page: …`) and the handler does not run.
  A schema that throws instead of returning issues answers `500`: that is a
  server bug, not a bad request. SSE routes take `params`, `headers` and `query`
  too.
- `check` runs after every field and the body decoded, with the same typed
  input the handler gets. Return issues to answer `400`; give each a path such
  as `['query', 'to']` and the message reads `query.to: …`:

  ```ts
  import { route } from '@arki/http';
  import { z } from 'zod';

  route.get('/range', {
    id: 'range',
    query: { from: z.coerce.number(), to: z.coerce.number() },
    check: ({ query }) => (query.to < query.from ? [{ message: 'must not be before from', path: ['query', 'to'] }] : undefined),
  });
  ```
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
import { defineFailure } from '@arki/failure';
import { route, routes } from '@arki/http';
import { z } from 'zod';

import { Order, usecases } from './fixture.ts';

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

import { type Db, createOrder, listOrders } from './fixture.ts';

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


import { core, listOrders } from './fixture.ts';

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

```ts skip="starts a server on port 3000 and hooks process signals"
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
import { defineApp } from '@arki/dot';
import { token } from '@arki/dot/plugin';
import type { RouteBundle } from '@arki/http';
import { http } from '@arki/http/dot';

import { adminPlugin, orders } from './fixture.ts';

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

```ts run
import { buildEngine, derive, HttpError, HTTP_ERROR_CODES, routes } from '@arki/http';

import { auth, dbForTenant, listOrders } from './fixture.ts';

// inside a `provides` factory — `auth` is an injected singleton
const withPrincipal = derive('principal', async req => {
  const p = await auth.verify(req.headers.get('authorization'));
  if (!p) throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'missing or invalid credentials');
  return p;
});

const orderRoutes = routes()
  .derive(withPrincipal)
  .derive('db', (_req, ctx) => dbForTenant(ctx.principal.tenantId))
  .bind(listOrders, async (_input, ctx) => ctx.db.orders.list());
```

A request with no credentials never reaches the handler:

```ts continue
const denied = await buildEngine([orderRoutes]).fetch(new Request('http://local/orders'));
if (denied.status !== 401) throw new Error(`got ${denied.status}`);
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
import { http } from '@arki/http/dot';

import { OrdersRoutes, cors, logger, origins, requestLog } from './fixture.ts';

http({ port: 3000, bundles: [OrdersRoutes], middleware: [requestLog(logger), cors(origins)] })
```

Middleware wraps the whole engine and is untyped by design; anything that
produces a per-request *value* belongs in a deriver instead. Standalone
users compose the same way with `composeMiddleware(engine.fetch, [...])`.

## Idempotency keys

`idempotent(...)` from `@arki/http/idempotency` is an `HttpMiddleware`. It runs each listed request once per `Idempotency-Key` and answers a repeat with the stored response. It is portable (Web Crypto only). The store is a `ResponseCache`: `@arki/journal/http` (Postgres) or `@arki/kv/redis/idempotency` (Redis).

```ts skip="needs a Postgres journal (the @arki/journal package), which this package does not depend on"
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

```ts skip="needs a Postgres journal (the @arki/journal package), which this package does not depend on"
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
binding is an async generator. Every yield is encoded with the event
schema and framed as a `data:` message; client disconnect aborts
`ctx.signal` and runs the generator's `finally`:

```ts
import { route, routes } from '@arki/http';
import { z } from 'zod';

import { Queued, Shipped, tracker } from './fixture.ts';

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
import { routes } from '@arki/http';

import { rpcHandler } from './fixture.ts';

routes().mount('/rpc', rpcHandler, { id: 'rpc', transport: 'orpc' });
```

## OpenAPI

```ts run
import { toOpenApi } from '@arki/http';

import { createOrder, listOrders, progress } from './fixture.ts';

const document = toOpenApi([listOrders, createOrder, progress], {
  title: 'shop-api',
  version: '1.0.0',
});

if (!JSON.stringify(document).includes('"/orders/{id}/progress"')) throw new Error('missing the progress path');
```

Deterministic — same contracts, byte-identical output. Each `params`,
`headers` and `query` field is one parameter (`required` unless it is
`optional(...)`), every status in `responses` is listed, a no-output route
documents `204`, and a `raw()` route is marked `x-arki-raw: true`.

Each schema describes itself through its own `~standard.jsonSchema`
converter (zod and arktype have one), asked for `draft-2020-12`. What the
server receives is described by the schema's input side, what it sends by
the output side, and a `codec()` by its `decode` input, the wire string.
`$defs` become `components.schemas`, so references still resolve. A schema
with no converter (valibot, a hand-written one) or a failed conversion throws
`ARKI_HTTP_E013` naming the route and the field; give it one with
`withJsonSchema(schema, jsonSchema)` from `@arki/schema`. Inside a DOT app,
contract actions put the JSON Schemas into the manifest, so
`dot explain --as openapi` renders the document from the static manifest
without booting anything.

## Typed client

`createClient` builds a fetch client from the same contracts the server binds.
Pass one contract for one call, or an object of contracts for one call per key:

```ts
import { createClient } from '@arki/http/client';

import { authorization, getOrder, listOrders } from './fixture.ts';

const orders = createClient({ listOrders, getOrder }, { baseUrl: 'https://api.example.com' });

const open = await orders.listOrders({ query: { status: 'open' } });
const order = await orders.getOrder({ params: { id: 'o42' } }, { headers: { authorization } });
```

- Input (`params`, `query`, `headers`, `body`) and output are typed from the
  contract. A wrong input does not compile.
- Params, headers, query and body are encoded with their schemas (`encode` of a
  `codec()`) and the output is decoded, exactly mirroring the server, so
  codecs round-trip. A field that fails answers `E400` before anything is sent.
  A missing `optional(...)` field, and a missing optional path segment, are
  left out of the URL.
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

import { partnerRoutes, partnerUrl } from './fixture.ts';

const partner = createClient(partnerRoutes, {
  baseUrl: partnerUrl, // set by a user: it must not reach your private network
  fetch: publicFetch(),
  policy: createRetryPolicy({ backoff: backoff.exponential({ base: 200 }).upTo(3) }),
  timeoutMs: 10_000,
});
```

- **`policy`** runs each attempt; any `@arki/resilience` policy fits (one with a
  fallback does not: its result may not be a response). The client, not the
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
- **`UnsafeUrlError`** is what the guard throws when it refuses a URL: not
  http(s), not a URL, or a private, loopback or link-local address, whether
  typed, in the DNS answer, or behind a redirect. No request reached that
  address, and the same URL is refused every time, so do not retry it.
  `safeFetchBytes` and `validatePublicURL` throw it too. A network failure
  still throws what the network throws.

## Without DOT

The core is framework-agnostic:

```ts
import { buildEngine, listen } from '@arki/http';

import { bundle } from './fixture.ts';

const engine = buildEngine([bundle]);
const handle = await listen(engine.fetch, { port: 3000 });
```

`listen` uses `Bun.serve` under Bun and `@hono/node-server` under Node.
Routing is Hono internally; no Hono type appears in the public API.

## Public imports

| Import | What it holds |
| --- | --- |
| `@arki/http` | `route`, `routes`, `buildEngine`, `listen`, `derive`, `HttpError`, `toOpenApi`, `raw`, `reply`, `codec`, `optional` |
| `@arki/http/dot` | `http()`, the Dot driver, and `endpoints()` |
| `@arki/http/client` | the typed fetch client |
| `@arki/http/idempotency` | `idempotent(...)`, an idempotency-key middleware |
| `@arki/http/webhooks` | signature schemes for signed webhooks |
| `@arki/http/context` | the ambient request context, a last resort |
| `@arki/http/projection` | the `dot explain --as openapi` projection |
| `@arki/http/public-fetch` | a fetch that refuses private addresses |

## Failure behaviour

Handlers and derivers fail with an `HttpError` or return a failure. The engine turns both into a coded envelope on the wire:

```text
{ "error": { "code", "message", "remediation?", "docsUrl?", "data?" } }
```

Rules:

- Match on `error.code`, never on the message.
- Validation failures answer 400 with `ARKI_HTTP_E400` and the failing fields in `data`.
- A handler that throws something else answers 500 with `ARKI_HTTP_E500`. In production the message is redacted.
- Boot and shutdown problems (`E0NN`) do not reach the wire. They surface in `app.diagnostics`.
- `listen` and `stop` reject with a coded error you can catch.

See [Error codes](#error-codes) for the full list.

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
| `ARKI_HTTP_E013` | a contract schema cannot describe itself as JSON Schema (no `~standard.jsonSchema`, or the conversion threw). Thrown by `toOpenApi` / `contractMeta`; fix with `withJsonSchema` |
| `ARKI_HTTP_E400` | request validation failed (params/headers/query/body) or body is not valid JSON |
| `ARKI_HTTP_E401` / `E403` | credential / permission rejection (thrown by your derivers) |
| `ARKI_HTTP_E404` | no route matches |
| `ARKI_HTTP_E408` | a client call got no response within `timeoutMs` (thrown by `@arki/http/client`, never sent on the wire) |
| `ARKI_HTTP_E410` / `E411` / `E412` | idempotency: key missing (400), key reused for another request (422), request with this key still running (409) |
| `ARKI_HTTP_E413` | request body larger than the route allows (413) |
| `ARKI_HTTP_E430` | `@arki/http/public-fetch` refused a URL: a private, loopback or link-local address, a bad scheme, or a redirect to one (thrown as `UnsafeUrlError`, never sent on the wire) |
| `ARKI_HTTP_E420` / `E421` / `E422` | webhook: signature headers missing or malformed, no signature matches, signed time outside the window (all 401) |
| `ARKI_HTTP_E500` | handler crash or output-schema violation |
| `ARKI_HTTP_E510` | a `Response` without `output: raw()`, or a plain value from a `raw()` route (answers 500) |
| `ARKI_HTTP_E511` | a result that does not fit the contract: undeclared `reply` status, or a value on a no-output route (answers 500) |

`E0NN` codes surface through the DOT lifecycle into `app.diagnostics`;
`E4xx`/`E5xx` codes surface on the wire in the error envelope (`E510` and
`E511` answer 500). Unexpected
error messages are redacted when `NODE_ENV=production`.

## Limits

- **Request bodies.** A body larger than the route allows answers 413 (`ARKI_HTTP_E413`). A webhook route reads at most `maxBodyBytes`.
- **Idempotency.** A key is remembered by the store you give it. A key reused with a different body answers 422. A request still running answers 409.
- **Webhooks.** A signed time outside the window answers 401 (`ARKI_HTTP_E422`). Keep your clock in sync.
- **Drain.** `stop` waits `drainTimeoutMs` (10 s by default), then rejects with `ARKI_HTTP_E005`.
- **Output.** Output is validated against the schema. A schema that keeps undeclared keys lets them out. Pick the fields you return.
- **OpenAPI.** A schema without a JSON Schema form throws `ARKI_HTTP_E013`. Wrap it with `withJsonSchema`.
- **Outbound URLs.** `public-fetch` refuses private, loopback and link-local addresses, also after DNS and redirects.

## Documentation

The [agent guide](docs/agent-guide.md) has the model, a task map and the rules. The Dot docs (`packages/dot/docs/`) cover plugin authoring and lifecycle.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, your runtime and the error `code`.

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
