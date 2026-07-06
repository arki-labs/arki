# RFC: `@arki/http` — the DOT HTTP adapter, and request scope without containers

- **Status:** ACCEPTED 2026-07-06 — all recommendations approved by founder, plus
  streaming support pulled into Phase 1 scope. Decisions: (A) `@arki/http`,
  (B) Hono as internal dep, (C) WebSockets deferred but **SSE/streaming
  first-class in Phase 1**, (D) health endpoint deferred to the
  runtime-health-contract RFC, (E) wire envelope reuses the full
  `DiagnosticIssue` field set (code/message/remediation/docsUrl).
- **Date:** 2026-07-06
- **Author:** Claude (session fbbe6be7), from the 2026-07-06 NestJS gap investigation
- **Depends on:** `@arki/dot` 0.2.0 (v2 DI, `hookSignals`, `hookTimeoutMs`/E015)
- **Related:** `packages/dot/docs/principles.md`, `packages/dot/docs/adapter-authoring.md`,
  the gap matrix in the 2026-07-06 investigation (session transcript)
- **Location note:** this RFC is internal. It must NOT move into `packages/dot/docs/`
  — that tree mirrors to the public `arki-labs/arki` repo.

## Summary

Ship a new package, **`@arki/http`**, that gives DOT apps a blessed way to
serve HTTP — the single biggest adoption blocker versus NestJS. Routes are
**typed contracts (pure data)** defined at module scope, **bound to handlers
inside pip `boot`** where services are already injected, collected as
**bundles** by an `http()` pip mounted last, and served over a fetch-standard
engine. Request scope is **not** a kernel feature: it is a typed, accumulating
per-request context derived by plain functions — "scope is data, not
containers."

Kernel changes are minimal and additive: `registerRoute` grows optional JSON
Schema fields so `dot explain --openapi` can render an OpenAPI document
without booting.

Two RFCs in one because the route-contribution direction decides the scoping
model: bundles collected by a last-mounted pip keep per-request state as
plain derived values, while an imperative registrar would have pushed it
toward ambient containers (see Rejected alternatives).

## Motivation

Nobody migrates a backend to a composition kernel that has no answer to
"how do I serve a request?" Today the answer is "bring your own Hono" — every
`apps/*/server` hand-wires Hono + middleware + health endpoint + queue
runtime start/stop, exactly the lifecycle plumbing DOT exists to own. Nest's
HTTP layer (controllers, guards, pipes, interceptors, `@nestjs/swagger`) is
the reason people tolerate its DI. We can close the gap with less surface:

| Nest concept | This RFC |
| --- | --- |
| `@Controller` + route decorators | route contracts (pure data) + `bind()` in `boot` |
| `@UseGuards` / pipes / interceptors | derivers and middleware — plain typed functions |
| `ValidationPipe` + class-validator | zod schemas on the contract (zod is already a kernel dep) |
| `@nestjs/swagger` decorators | `toOpenApi(contracts)` — falls out of the schemas, zero annotations |
| Request-scoped providers | derived request context + factory closures |
| `enableShutdownHooks` | already shipped: `hookSignals` + serialized transitions |
| Devtools route explorer (paid) | `manifest.routes` + `dot explain --openapi` (free, agent-readable) |

What we deliberately do **not** copy: decorators (breaks Bun/esbuild),
controller auto-scanning (violates principle 3 — determinism), a global DI
container with scopes (violates principle 2 — no hidden core, and it is
Nest's own documented performance trap).

## Doctrine constraints (what shaped this design)

1. **Slightly playful, very precise** — `route`, `bind`, `bundle`, `derive`,
   `mount`. One word each. Errors carry code + remediation + docsUrl.
2. **Pips ARE the app** — the kernel gains no HTTP knowledge. `@arki/http` is
   an adapter package like `@arki/db`. Remove the pip, remove the server.
3. **Deterministic by default** — route table order = bundle order = pip
   declaration order. OpenAPI output is byte-identical across runs. No
   route auto-discovery from the filesystem, ever.
4. **Agent-discoverable everywhere** — contracts land in `manifest.routes`
   with schemas; wire errors use a coded envelope; `dot doctor` flags
   declared-but-unbound contracts.
5. **Kernel has zero optional dependencies** — everything here lives in
   `@arki/http` with `@arki/dot` as an optional peer, per
   `adapter-authoring.md`. The only kernel change is additive manifest
   metadata.

## Design — Part 1: the HTTP adapter

### Package layout

```text
packages/http/
├── src/
│   ├── index.ts      // route contracts, bind, bundle, derive, toOpenApi — framework-agnostic
│   ├── dot.ts        // http() pip factory
│   ├── context.ts    // opt-in ambient request context (ALS) — separate entry
│   └── engine.ts     // internal: Hono + Bun.serve / @hono/node-server
└── package.json      // exports: ".", "./dot", "./context"; @arki/dot optional peer
```

Engine: **Hono as an internal dependency** (not a peer, never leaked in
public types). It is fetch-native, runs on Bun and Node, and is already the
de-facto server library in this workspace (novelette, games-platform,
movietracker servers). We write zero router code. Listening uses `Bun.serve`
when available, `@hono/node-server` otherwise. Swapping the engine later is
a non-breaking implementation detail precisely because no Hono type appears
in the API.

### Route contracts — pure data at module scope

```ts
import { route } from '@arki/http';
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

A contract is method + path + zod schemas + a stable `id`. No handler, no
services, no I/O — which is what makes three things possible:

- `configure` can register it in the manifest (configure is sync, pre-boot);
- OpenAPI generation is static — no boot required;
- the handler type is fully inferred when you bind.

### Binding — handlers live in `boot`, where DI already happened

The contract/implementation split is the whole trick. Handlers need
services; services exist only after `boot`; so binding happens in `boot`,
closing over the pip's typed needs:

```ts
import { bind, routes, type RouteBundle } from '@arki/http';
import { pip, provide, service, token } from '@arki/dot/pip';

export const OrdersRoutes = token<RouteBundle>()('orders.routes');

export const ordersPip = pip({
  name: 'orders',
  needs: { db: service<Db>() },
  configure(ctx) {
    routes.register(ctx, [listOrders, createOrder]); // manifest metadata, schemas included
  },
  async boot({ db }) {
    return provide(OrdersRoutes, routes.bundle([
      bind(listOrders, async ({ query }) => db.orders.list(query)),
      bind(createOrder, async ({ body }, ctx) => db.orders.create(body, ctx.requestId)),
    ]));
  },
});
```

`bind(contract, handler)` infers the handler signature from the contract's
schemas: `({ params, query, body }, ctx) => output | Response`. Returning
the declared `output` type serializes as JSON (and is validated against the
output schema — the contract is enforced in both directions); returning a
raw `Response` is the escape hatch (redirects, files, custom streams —
fetch-native, no special API).

A `RouteBundle` is a plain value: contracts + bound handlers + derivers.
It is published as an ordinary DOT service under a token — no new kernel
concept.

**Implementation note (locked during build):** the bundle is authored
through a small builder — `routes().derive(...).bind(...).mount(...)` —
because deriver-added context keys must be visible in the *type* of later
`bind` handlers, and a flat `bundle([...binds], { derive })` cannot thread
that. Same accumulation idiom as `defineApp().use()`.

### Streaming — first-class, two tiers

1. **Typed SSE contracts.** `route.sse(path, { id, event: zodSchema })`
   declares a `text/event-stream` route; binding takes an async generator
   and each yielded value is validated against the event schema and framed
   as an SSE `data:` message. Client disconnect aborts `ctx.signal`, which
   terminates the generator. Optional `heartbeatMs` emits `:keepalive`
   comments. SSE contracts land in the manifest and OpenAPI as
   `text/event-stream` with the event schema.
2. **Raw streams.** Any handler may return a `Response` wrapping a
   `ReadableStream` — file downloads, AI token streams, proxied bodies.
   The engine is fetch-native end to end, so this needs no adapter API.

### Collection — the `http()` pip mounts LAST and names its inputs

```ts
import { http } from '@arki/http/dot';

const app = await defineApp('shop-api')
  .use(env({ schema }))
  .use(db({ url: DATABASE_URL }))
  .use(ordersPip)
  .use(billingPip)
  .use(http({ port: 3000, bundles: [OrdersRoutes, BillingRoutes] }))
  .start();
```

`http()` derives its `needs` shape **from the tokens you pass** — the
factory builds `{ 'orders.routes': service<RouteBundle>(), ... }` at call
time, so the existing `.use()` guard enforces, at compile time, that every
listed bundle is published by an earlier pip. Forget to mount `ordersPip`
and the `.use(http(...))` line fails to typecheck. This is the same
witness machinery the kernel already ships; the adapter adds no type magic
of its own.

Explicit bundle lists are the anti-Nest position, on purpose: no controller
scanning, no `Reflect.getMetadata`, no "why is this route registered?"
The route table is readable from the `defineApp` call site, and the
observed dependency edges (feature pip → http pip) land in
`manifest.dependencies` for free.

### Lifecycle mapping — where mounting-last pays off

| Hook | `http()` pip behavior |
| --- | --- |
| `configure` | registers its own meta-routes (none by default) |
| `boot` | collect bundles → build the router → publish `httpServer` handle. **Not listening yet.** |
| `start` | listen on `port` (option or `$config`). All feature boots completed before any start — the route table is final. |
| `stop` | stop accepting, drain in-flight requests (`drainTimeoutMs`, default 10 s) |
| `dispose` | close the listener and free the port |

Because `stop` runs in **reverse declaration order** and `http()` is
declared last, **ingress stops first** — requests stop arriving before
feature pips' `stop`/`dispose` hooks tear down workers and pools. This is
the correct drain order and it falls directly out of "mount last"; the
registrar alternative (below) gets it backwards. `hookSignals(app)` +
serialized transitions (0.2.0/0.1.3) make the whole shutdown path race-safe
with zero extra code.

The published `httpServer` service is a small handle:
`{ url, port, fetch, inflight() }` — `fetch` being the composed
`(req: Request) => Promise<Response>`, which is also the unit-test seam
(call the app without a socket).

### Middleware, guards, and mounting foreign handlers

- **Middleware** are fetch-shaped plain functions
  (`(req, next) => Promise<Response>`), attachable on the `http()` pip for
  app-wide concerns (CORS, logging) — first in the list runs outermost,
  thrown errors map to the coded envelope. Per-bundle middleware is
  deliberately NOT in v1: derivers cover the per-bundle cases that carry
  values, and two attachment points for the same concept invites confusion.
- **Guards** are just derivers (Part 2) that throw `HttpError(401, ...)`.
  No separate guard concept.
- **`bind.mount(path, fetchHandler, { transport, id })`** mounts any
  fetch-based handler — an oRPC router, a tRPC fetch adapter, a static-file
  handler — as one manifest route with `transport: 'orpc' | 'trpc' | 'custom'`.
  The `RouteTransport` union in `manifest.ts:37` has been waiting for this
  since v1. This is the migration on-ramp for every existing backend: the
  RPC router moves in unchanged on day one.

### Wire-level errors — the envelope is part of the API

Handler/validation failures serialize as a coded envelope, mirroring the
kernel's diagnostics doctrine on the wire:

```json
{ "error": { "code": "ARKI_HTTP_E400", "message": "query.status: invalid enum value", "docsUrl": "..." } }
```

- zod validation failure → 400 with the flattened issue list;
- `HttpError(status, code, message)` thrown anywhere → that status;
- unknown thrown error → 500, code `ARKI_HTTP_E500`, message redacted in
  production mode, full in dev.

Agents consuming ARKI-served APIs get machine-readable failures without
per-app convention drift.

## Design — Part 2: request scope

### The problem, stated precisely

Nest's request-scoped providers re-resolve a DI subgraph per request. The
costs are documented and structural: scope is infectious (a request-scoped
provider makes everything that injects it request-scoped, "bubbling up" to
the controller), resolution happens at request time (Nest's own docs warn
about the latency), and testing needs `ContextIdFactory` ceremony. The
feature exists because in a container world, "per-request value" has no
home other than the container.

DOT does not have that problem to solve, because DOT services are
compile-time wired singletons. What remains is the legitimate need: values
that exist per request — the authenticated principal, a request id, a
tenant-scoped DB handle, a child logger — delivered to handlers **typed**.

### Position: scope is data, not containers

Per-request state is a **value passed to your function**, not a service
resolved from a scope. The kernel gains no scope system, no new hook, no
per-request anything. Three layers, all in `@arki/http`:

**1. Base request context** — built by the adapter for every request:

```ts
type BaseRequestCtx = {
  readonly req: Request;
  readonly url: URL;
  readonly requestId: string;   // inbound x-request-id, else crypto.randomUUID()
  readonly signal: AbortSignal; // aborts when the client disconnects
};
```

**2. Derivers — typed, accumulating, ordered.** A deriver is a named
function from `(req, ctx)` to a value; each one adds a key to the context
type. Same accumulation trick as the app builder, applied per-request:

```ts
import { derive } from '@arki/http';

// inside ordersPip's boot — `auth` is an injected singleton need
const withPrincipal = derive('principal', async (req) => {
  const p = await auth.verify(req.headers.get('authorization'));
  if (!p) throw new HttpError(401, 'ARKI_HTTP_E401', 'missing or invalid credentials');
  return p;
});

const withTenantDb = derive('db', (_req, ctx) => dbForTenant(ctx.principal.tenantId));

routes.bundle([...binds], { derive: [withPrincipal, withTenantDb] });
// handler ctx: BaseRequestCtx & { principal: Principal; db: Db }
```

Derivers run in declaration order (deterministic), later derivers see
earlier keys typed, and a deriver that throws short-circuits into the error
envelope — which is the entire "guard" story. Because bundles are built in
`boot`, derivers close over injected singletons; **request scope is
function application over the singleton graph**, resolved at compile time,
executed at O(awaited functions) per request — no container walk.

**3. Factory closures for "request-scoped services."** Nest's canonical
example — a per-tenant database — is a singleton factory plus a deriver,
as `withTenantDb` above shows. The pattern needs no framework support and
we should document it as *the* answer rather than shipping API for it.

### Ambient context — the last resort, fenced off

Explicit `ctx` threading fails in one honest case: code deep in a call
stack that cannot grow a parameter (log enrichment inside a shared
library). For that, `@arki/http/context` (separate entry, never re-exported
from the root) provides an `AsyncLocalStorage`-backed
`requestContext(): BaseRequestCtx | undefined`, populated by the adapter
around each request. Documented in the same register as the kernel's three
unsafe points: *ambient context is a smell; reach for it only when a
signature is out of your control.* Note that OTel trace context already
propagates this way (`@opentelemetry/api` is a kernel dep), so spans and
logs correlate per-request today without any of this — the ALS entry is for
app data, not telemetry.

### What we explicitly refuse

- **No kernel scope system** (`scope: 'request'` on pips) — infectious,
  runtime-cost, violates principles 2 and 3.
- **No per-request pip instantiation** — pips boot once; anything else
  breaks the manifest's meaning.
- **No ctx mutation** — derivers accumulate immutably; `ctx.foo = bar`
  is not in the API.

## OpenAPI — falls out, doesn't bolt on

Contracts are static and carry zod schemas, so:

- **`toOpenApi(bundlesOrContracts, info)`** in `@arki/http` core: pure,
  deterministic, byte-identical output (principle 3). zod v4's native
  `z.toJSONSchema` does the conversion — no new dependency.
- **`dot explain --openapi`** in the kernel CLI: renders from
  `manifest.routes` without booting, once `registerRoute` carries schemas
  (next section). Composes with `--json` like `--graph` does.

This beats `@nestjs/swagger` structurally: Nest reconstructs types from
decorator metadata at runtime and still needs `@ApiProperty` annotations;
here the schema *is* the validation *is* the documentation.

## Kernel changes (dot 0.3.0 — additive only)

1. `DotConfigureContext.registerRoute` gains optional fields:
   `description?: string`, `input?: JsonSchema`, `output?: JsonSchema`
   (plain JSON Schema values, already serializable — determinism holds).
2. `RouteManifest` (`manifest.ts:68`) carries the same optional fields.
3. `dot explain --openapi` CLI flag rendering from the manifest.

Nothing else. No new hooks, no new lifecycle states, no new service kinds.
`routes.register(ctx, contracts)` is adapter-side sugar that calls
`ctx.registerRoute` per contract with schemas converted.

**Doctor integration (adapter-side):** duplicate method+path is rejected at
boot (`ARKI_HTTP_E002`, error). The declared-vs-bound warnings —
declared-but-unbound (`ARKI_HTTP_E003`), bound-but-undeclared
(`ARKI_HTTP_E004`) — are **deferred**: pip hooks have no channel to push
warning-severity `DiagnosticIssue`s today (issues are derived from thrown
errors), and inventing a side channel would violate principle 2. They land
when the kernel grows a diagnostics write seam; codes stay reserved.

## Error codes

Package-scoped per `adapter-authoring.md` (`<PKG>_E<NNN>`):

| Code | Meaning |
| --- | --- |
| `ARKI_HTTP_E001` | listen failed (port in use, permission) — remediation names the port and the option/env to change it |
| `ARKI_HTTP_E002` | duplicate route: two bindings claim the same method+path (also: a bundle token listed twice) |
| `ARKI_HTTP_E003` | contract declared in `configure` but never bound (warning — RESERVED, deferred until the kernel has a diagnostics write seam) |
| `ARKI_HTTP_E004` | route bound but not declared in the manifest (warning — RESERVED, same) |
| `ARKI_HTTP_E005` | drain timeout exceeded on `stop` — in-flight count included |
| `ARKI_HTTP_E006` | invalid mount path |
| `ARKI_HTTP_E007` | deriver key duplicates an earlier deriver or a base context key |
| `ARKI_HTTP_E008` | bundle token's service missing at boot (erased composition only — the typed guard makes this unrepresentable) |
| `ARKI_HTTP_E400` / `E401` / `E403` / `E404` / `E500` | wire envelope codes (validation, auth, forbidden, no route, handler crash / output-schema violation) |

## Migration sketch — `apps/novelette/server`

Today: ~200 lines of hand-wired Hono + CORS + health endpoint + manual
`startQueueRuntime`/`stopQueueRuntime` + process signal handling. After:

```ts
const app = await defineApp('novelette-server', { hookTimeoutMs: 30_000 })
  .use(env({ schema: serverEnv }))
  .use(db({ url }))
  .use(kv({ url }))
  .use(queue({ ... }))                    // future @arki/queue/dot pip — separate work
  .use(workersPip)                        // app pip: bull workers, needs { db, queue }
  .use(http({ port, bundles: [HealthRoutes, BoardRoutes] }))
  .start();

hookSignals(app);
```

Lifecycle ordering, drain-before-worker-teardown, health introspection, and
signal handling all come from the kernel instead of app code. This app is
the proposed **proving ground** (Phase 1 exit criterion).

## Rejected alternatives

- **Imperative registrar (http pip first, features register into it).**
  Familiar (it is how Express/Hono feel) but: drain order inverts (server
  declared first stops *last*, so requests keep arriving during feature
  teardown), route provenance disappears from the type system, and the
  registrar becomes ambient shared state — the first step toward a
  container. The bundle model keeps every dependency visible and typed.
- **Kernel-owned HTTP (`defineApp({ http: ... })`).** Violates principles
  2 and 5 outright. Not considered further.
- **Hand-rolled router.** Zero benefit over Hono's; permanent maintenance
  cost; loses the battle-tested path-param/wildcard edge cases.
- **Nest-style `scope: 'request'`.** See Part 2 — the feature is a
  container artifact, not a need in a compile-time-wired world.
- **tRPC/oRPC as the only blessed surface (no REST layer).** The RPC
  packages stay first-class via `bind.mount`, but public/partner APIs,
  webhooks, and health endpoints are REST-shaped; an HTTP story that
  cannot express them is not an HTTP story.

## Delivery plan

| Phase | Contents | Exit criterion | Status |
| --- | --- | --- | --- |
| 1 | `packages/http` (private): contracts, `routes()` builder, `derive`, `HttpError`, `toOpenApi`, SSE streaming, app-wide middleware, `http()` pip on Hono; 36 tests incl. real-socket drain + E005 watchdog | novelette (or games-platform) server runs on it in prod | **DONE 2026-07-06** — novelette server migrated + smoke-verified live under Bun (payload-faithful, CORS, degradation, signal drain). The migration surfaced and fixed two gaps: the missing middleware option, and a kernel provides-inference hole on void-returning boots (`InferredProvides`) |
| 2 | dot 0.3.0: additive `registerRoute` schema fields + `dot explain --openapi` | OpenAPI doc generated from a real app's manifest, byte-stable across runs | **SHIPPED 2026-07-06** (changeset pending release) |
| 3 | `@arki/http/context` (ALS entry) + auth deriver recipe in `@arki/auth` docs | one real guarded route in a shipped app | **DONE 2026-07-07** — session-deriver recipe in `packages/auth/README.md`; novelette `/admin/queues/status` guarded live (basic-auth deriver, timing-safe, `WWW-Authenticate` challenge via the new `HttpError.headers`) |
| 4 | Public promotion via `add-new-package.md` (LICENSE, README, wave entry, `private: false`) | scorecard OPEN, first npm publish at 0.0.x | open — LICENSE + README already in place |

Versioning: experimental 0.0.x track per release doctrine. `@arki/dot` peer
range `^0.3.0` (note: caret on 0.x means every dot minor forces an
`@arki/http` republish — same cascade rule as the existing adapters).

## Open questions (founder decisions)

A. **Package name** — `@arki/http` (recommended: it is the transport, not
   "a server") vs `@arki/server`.
B. **Engine disclosure** — Hono as internal dep (recommended) is invisible
   in types but visible in the lockfile and install size (~14 kB). Accept,
   or insist on zero-dep?
C. **WebSockets** — defer (recommended; SSE/streaming already work via raw
   `Response`), or in scope for Phase 1?
D. **Health endpoint** — keep out of `@arki/http` and let the future
   runtime-health-contract RFC own it (recommended), or ship a default
   `/healthz` route now?
E. **Wire envelope shape** — reuse the kernel `DiagnosticIssue` fields
   verbatim (code/message/remediation/docsUrl) or a slimmer public shape
   without `remediation`?
