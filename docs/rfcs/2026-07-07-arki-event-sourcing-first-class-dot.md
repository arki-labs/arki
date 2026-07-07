# RFC: `@arki/event-sourcing` as a first-class DOT citizen — bundles, es actions, event catalog

- **Status:** ACCEPTED 2026-07-07 — founder decisions A–D resolved:
  (A) `bundles`, (B) `event-catalog`, (C) **all four** hand-wired backends
  migrate in Phase C, (D) 0.1.x options kept as the dynamic path. Rev 4
  after Codex adversarial challenge (4 critical / 7 high; all folded or
  rebutted), self-review, and a post-acceptance Codex consult
  (READY-WITH-CHANGES → exit criteria tightened; see Review log).
- **Date:** 2026-07-07
- **Author:** Claude (session 548f7a6c), from the founder requirement "event
  sourcing must be very easy to integrate and turned on"
- **Depends on:** RFC `2026-07-07-dot-transport-agnostic-actions.md`
  (ACCEPTED — actions model, projections, `toDotAction()` protocol; this RFC
  ships after its phases 1–3 wave), `@arki/event-sourcing` 0.1.5 (Emmett
  store, builders, existing dot pip), `@arki/dot` 0.4.0 (planned)
- **Related:** `docs/rfcs/2026-07-06-arki-http-adapter-and-request-scope.md`
  (the bundle-collection pattern this RFC reuses),
  `packages/dot/docs/adapter-authoring.md`
- **Location note:** internal; must NOT move into `packages/dot/docs/`
  (public mirror).

## Summary

`@arki/event-sourcing` already has a dot pip — but it is centralized and
invisible. `eventSourcing({ projections, commandHandlers })` forces the app
root to enumerate every feature's handlers, and nothing it registers lands
in the manifest: `dot explain` renders an event-sourced app as if it did
nothing. Meanwhile four backends (brandability, everseek, loonyjobs,
typeroom) don't use the pip at all — each hand-wires `getEventStore` in a
`store.ts`, the ES replay of the "bring your own Hono" problem the http RFC
eliminated.

This RFC makes event sourcing a **one-line, feature-local, agent-visible**
capability by reusing two proven patterns:

1. **Bundles** (from `@arki/http`): feature pips publish `EsBundle` values
   under tokens; `eventSourcing({ bundles: [OrdersEs, BillingEs] })`
   derives its `needs` from the tokens, so forgetting to mount a feature pip
   fails to typecheck. Zero-config `eventSourcing()` still boots append-only
   with the env-resolved store URL.
2. **Actions** (from the accepted transport-agnostic RFC): ES becomes the
   third binding. Commands are `direction: 'in'` actions, emitted events are
   `direction: 'out'` actions — both with zod-derived JSON Schema payloads
   in `meta` — and a `--as event-catalog` projection renders the app's full
   event model without booting.

No kernel changes. That is the point: ES proves the actions abstraction as
a consumer, not a stakeholder.

## Motivation

- **Feature locality.** Today a feature owning `PlaceOrder` cannot carry its
  own handler registration; the app root must import and list it. The http
  RFC's bundle model solved this identically-shaped problem: contracts +
  handlers live with the feature, collection is typed and explicit.
- **Turned on by default.** "Easy to integrate" means `.use(eventSourcing())`
  and nothing else for the append-only case — URL from
  `EVENT_STORE_URL`/`EVENTSTORE_URL`/`EVENT_DB_URL` (already implemented),
  store opened at `boot`, pool closed at `dispose` (already implemented).
  The friction is not boot ceremony; it is contributing domain logic.
- **Agent discoverability.** Commands and events are the app's most
  important boundary vocabulary and today they are invisible to
  `dot explain`, `dot doctor`, and every agent reading the manifest. The
  actions model exists precisely to carry them.
- **Four hand-wired apps** prove demand and provide migration targets.

## Design

### 1. Feature side — pure data + bundle, mirroring http

Commands and events are already pure data with zod schemas
(`defineCommand`, `defineEvent` builders). They gain `toDotAction()`:

```ts
// features/orders/domain/es.ts — module scope, pure data
export const placeOrder = defineCommand({
  type: 'PlaceOrder',
  inputSchema: z.object({ orderId: OrderIdSchema, items: z.array(ItemSchema) }),
});
export const orderPlaced = defineEvent({
  type: 'OrderPlaced',
  dataSchema: z.object({ orderId: OrderIdSchema, total: z.number() }),
});
```

`toDotAction()` produces, at configure time (zod → JSON Schema once, the
`contractMeta` trick):

| Source | Action |
| --- | --- |
| `defineCommand({ type: 'PlaceOrder', … })` | `{ id: 'PlaceOrder', binding: 'es', direction: 'in', address: 'PlaceOrder', metaSchema: '@arki/event-sourcing/action-meta@1', meta: { kind: 'command', input } }` |
| `defineEvent({ type: 'OrderPlaced', … })` | `{ id: 'OrderPlaced', binding: 'es', direction: 'out', address: 'OrderPlaced', metaSchema: '…@1', meta: { kind: 'event', data } }` |

**Identity rules (rev 2, from review):**

- The action `id` IS the Emmett type string. A builder output at module
  scope has no feature prefix to derive, and Emmett already requires
  command types to be globally unique for bus dispatch — so the kernel's
  duplicate-`(binding, id)` check (E016 in the actions RFC) enforces a
  constraint Emmett implies anyway. Commands and events share one id
  namespace under `binding: 'es'`: a command and an event with the same
  type string is a collision, by design.
- **No `streamPrefix` in `meta`.** Stream naming lives in `getStreamName`,
  a function supplied at `boot` via `es.handle` — it does not exist at
  configure time and MUST NOT be faked as static metadata.
- `toDotAction()` is dependency-free: a plain method returning plain data,
  no `@arki/dot` import — the package's optional-peer boundary holds.
  Phase A carries a test that imports the command/event builders with
  `@arki/dot` absent.
- zod → JSON Schema uses zod v4's native `z.toJSONSchema`, the same
  supported subset as `@arki/http` contracts; a schema the converter
  rejects throws at configure time and surfaces as a coded configure
  failure, never a silently-wrong catalog.

Handlers bind in `boot`, where DI already happened — same
contract/implementation split as http:

```ts
export const OrdersEs = token<EsBundle>()('orders.es');

export const ordersEsPip = pip({
  name: 'orders-es',
  needs: { pricing: service<Pricing>() },
  actions: [placeOrder, orderPlaced],          // toDotAction() sources
  boot({ pricing }) {
    return provide(OrdersEs, es.bundle({
      handlers: [
        es.handle(placeOrder, orderDecider(pricing), cmd => `order-${cmd.data.orderId}`),
      ],
      readModels: [orderReadModel],             // Emmett PG projections
    }));
  },
});
```

**Naming note — the projection collision.** Emmett's read-side "projections"
and dot's document "projections" now share an app. The bundle API says
**`readModels`** — the accurate word for what they build — so the two
concepts never collide in DOT-facing code. Emmett-internal vocabulary is
unchanged; docs say "read-model projections" on first mention.

### 2. App side — collection, typed

```ts
const app = await defineApp('shop-api')
  .use(env({ schema }))
  .use(db({ url: DATABASE_URL }))
  .use(ordersEsPip)
  .use(billingEsPip)
  .use(eventSourcing({ bundles: [OrdersEs, BillingEs] }))
  .start();
```

`eventSourcing()` derives its `needs` from the listed tokens (the exact
witness machinery `http()` uses) — forget `.use(ordersEsPip)` and the
`eventSourcing(...)` line fails to typecheck. Boot order: feature boots
complete before the collector boots, so the handler table is final before
the message bus accepts a command. `stop`/`dispose` in reverse declaration
order closes the bus before the store pool — the same drain logic that made
"mount last" correct for http.

`eventSourcing()` with **no arguments stays legal**: opens the store from
env, publishes `eventStore` + `messageBus` with no handlers — the
append-only / read-models-elsewhere mode, and the smallest possible
"turned on". Dispatching a command nobody handles is a **coded error**
(`E004`), not silent Emmett behavior.

**Composition order — the chain must be drawn.** Feature pips that *handle*
commands publish bundles; feature pips that *send* commands (an http route
posting `PlaceOrder`) need the `messageBus` service. The mount order is
therefore:

```text
es-feature pips (declare handlers) → eventSourcing() → http-feature pips (need messageBus) → http()
```

A feature that both handles `PlaceOrder` AND exposes `POST /orders` would
need `messageBus` while `eventSourcing()` needs its bundle token — a cycle.
The mandated pattern is the **two-pip split** (`orders-es` + `orders-http`),
which the example above already models; the README documents it as the
rule, not a workaround. Reverse-order stop then does the right thing
end-to-end: http drains ingress first, then es stops dispatch, then the
store pool closes.

**Bus contract — stated, not implied.** The 0.2 message bus is strictly
**in-process, synchronous dispatch**: no durability, no delivery guarantee
across instances, restarts, or rolling deploys. It is the typed seam
between "a command arrived" and "a decider ran", not work-distribution
infrastructure — durable/async command transport is `@arki/queue`'s job
(recipe in the README: a queue worker that `messageBus.send`s). The es pip
gains a **`stop` hook**: it flips the dispatcher to closed (new `send`
calls reject with `E005`), awaits in-flight dispatches, and only then does
`dispose` close the pool — commands can no longer write through a closing
store during shutdown.

**Known limitation (documented):** declared es actions with no
`eventSourcing()` collector mounted are dead declarations — the manifest
shows them, nothing executes them. The kernel cannot know (it is
transport-agnostic by design); a future `dot doctor` adapter-check seam is
the home for this validation. Code reserved: `E006`.

### 3. The event catalog — `--as event-catalog`

The pip registers a dot projection in `configure`:

```ts
ctx.registerProjection({ format: 'event-catalog', binding: 'es', module: '@arki/event-sourcing/projection' });
```

`project(manifest)` renders every `binding: 'es'` action (after verifying
`metaSchema`) into a deterministic catalog document: commands with input
schemas, events with data schemas, grouped by pip. Golden-output test, per
the actions RFC's purity contract. This is the ES analogue of
`--as openapi` and lands in the same CLI with zero kernel work.

**v1 catalog scope: commands and events only.** Read models bind at `boot`
(they close over injected services), so they are structurally invisible to
the configure-time manifest — the catalog does not pretend otherwise. If
read-model coverage ("which events feed which read models") earns a
declarative registration later, it arrives as ordinary meta on a future
action-meta version, not as a guess.

### 4. HTTP exposure — a recipe, not a framework

A command reachable over HTTP is two lines in an http bundle, closing over
the injected bus:

```ts
bind(placeOrderRoute, async ({ body }) => messageBus.send(placeOrder(body)));
```

Documented as *the* recipe in the package README. Rejected: auto-generating
routes from commands (couples two adapters; violates "explicit bundle
lists"; the http RFC already rejected controller-scanning in its own
domain).

### 5. Lifecycle & errors

| Hook | behavior |
| --- | --- |
| `configure` | register `eventStore` + `messageBus` services (as today), es actions arrive declaratively from feature pips, register the `event-catalog` projection |
| `boot` | resolve URL (E001, as today), open store, collect bundles (declared + dynamic 0.1.x options, duplicate-checked together), attach handlers, publish services |
| `stop` | close the dispatcher (new sends reject with E005), await in-flight dispatches |
| `dispose` | close pool (as today) |

Read models registered via `es.bundle` are Emmett inline PostgreSQL
projections: they run **transactionally with the append**, on the event
store's own pool. That pool is deliberately separate from `db({ url })` —
the event store owns its connection lifecycle; the RFC does not create an
atomic boundary between app-table writes and event appends, and the docs
say so (share a database if you want, not a transaction).

Coded errors, extending the existing table:

| Code | Meaning |
| --- | --- |
| `EVENT_SOURCING_PIP_E001` | store URL not configured (exists) |
| `EVENT_SOURCING_PIP_E002` | duplicate command type across collected bundles + dynamic options — two handlers claim `PlaceOrder` |
| `EVENT_SOURCING_PIP_E003` | bundle token's service missing at boot (erased composition only — the typed guard makes it unrepresentable) |
| `EVENT_SOURCING_PIP_E004` | command dispatched with no attached handler (covers zero-config mode and declared-but-unbound drift at the moment it bites) |
| `EVENT_SOURCING_PIP_E005` | command dispatched after `stop` — the dispatcher is closed |
| `EVENT_SOURCING_PIP_E006` | RESERVED — declared es action with no collector / handler parity check, pending the kernel diagnostics write seam (same deferral as `ARKI_HTTP_E003`/`E004`) |
| `EVENT_SOURCING_PIP_E007` | command/event schema rejected by the JSON-Schema converter at configure time |

## Changes by package

- **`@arki/event-sourcing` 0.2.0:** `toDotAction()` on
  `defineCommand`/`defineEvent` outputs (dependency-free, tested without
  `@arki/dot` installed); `es.bundle`/`es.handle` + `EsBundle` type;
  `eventSourcing({ bundles })` (token-derived needs; the 0.1.x
  `{ projections, commandHandlers }` options stay accepted through 0.2.x
  as the dynamic path, deprecated — dynamic handlers are
  **manifest-invisible**: they may execute commands that appear in no
  manifest and no catalog, which is intentional deprecated behavior, not a
  bug; features wanting visibility declare via `actions:` or
  `ctx.registerAction`); `stop` hook +
  dispatcher close; E002–E007; new export `./projection` (event catalog +
  golden test); pip `version` sourced from the package version (today it
  hard-codes `0.1.0` against a 0.1.5 package — fixed in Phase A); README
  chapters: HTTP recipe, queue recipe for durable command transport, bus
  contract, two-pip split rule. Peer: `@arki/dot@^0.4.0` (optional,
  unchanged).
- **`@arki/dot`:** nothing. Zero lines — the litmus criterion applied to a
  third binding.
- **Apps:** migrate ALL FOUR hand-wired backends (founder decision C) —
  ordered smallest-first inside Phase C: loonyjobs → typeroom → everseek →
  brandability. The first migration is the proving ground; gaps it surfaces
  are fixed before the remaining three proceed. (everseek note: its 62
  per-site eslint-disables are never relaxed centrally — edits stay
  surgical.) **Config invariant:** these apps read `env.DB_URL`; the pip's
  env fallbacks (`EVENT_STORE_URL` etc.) do NOT match. Every migration
  passes `dbUrl: env.DB_URL` explicitly — zero Coolify env changes in this
  RFC; renaming env vars is a separate, deployment-verified migration if
  ever wanted.
- **Template sync:** if the application template grows an ES example, it
  uses bundles from day one.

## Rejected alternatives

- **Keep centralized `{ projections, commandHandlers }` as the only path.**
  No feature locality, no manifest visibility; the app root becomes the
  registry the bundle model exists to avoid.
- **Auto-discover deciders/handlers** (filesystem or registry scanning).
  Violates determinism doctrine; same rejection as controller-scanning in
  the http RFC.
- **Teach the kernel about ES** (an `events` manifest section, a
  `dispatchCommand` kernel API). The actions RFC exists so this never
  happens again; ES is binding #3, not a kernel stakeholder.
- **Auto-expose commands as HTTP routes.** Adapter-to-adapter coupling with
  auth/validation questions the app must own; the two-line recipe keeps the
  decision visible.
- **Render the catalog as AsyncAPI instead of a custom format.** AsyncAPI
  models channels/operations for message *transports*; an event-sourced
  command/event model maps awkwardly (streams ≠ channels, deciders have no
  home). A dedicated `event-catalog` format renders the truth; an AsyncAPI
  projection can be added later if a real consumer appears (question B).

## Delivery plan

Ships after the actions RFC's phases 1–3 wave (needs `toDotAction`,
`registerProjection`, `--as`). Independent of the queue litmus (phase 4
there); ES becomes binding #3 and a second zero-kernel-diff proof.

| Phase | Contents | Exit criterion | Status |
| --- | --- | --- | --- |
| A | `es.bundle`/`es.handle`, `eventSourcing({ bundles })`, `stop` dispatcher close, E002–E007, pip-version alignment, zero-config boot test | bundle-collected handler dispatches through the bus in package tests; `eventSourcing()` no-args boots; **shutdown sequence proven**: an in-flight dispatch completes, a post-`stop` send rejects with E005, and `dispose` closes the pool only after the in-flight dispatch finished | PLANNED |
| B | `toDotAction()` on command/event builders (incl. no-`@arki/dot` import test) + `./projection` (event catalog, golden test) | `dot explain` shows es actions; `--as event-catalog` byte-stable on the proving app; **manifest honesty proven**: bundle-declared actions appear, dynamic 0.1.x handlers do not; E007 fires on an unsupported schema | PLANNED |
| C | Migrate all four hand-wired backends (loonyjobs → typeroom → everseek → brandability; first is the proving ground, gaps fixed before the rest proceed) | every `store.ts` deleted; all four apps boot via `.use(eventSourcing(...))` passing `dbUrl: env.DB_URL` explicitly (zero new Coolify env vars); **at least one real ES command flow per app covered by integration/e2e**, not just boot + typecheck; **kernel diff = 0 lines** | PLANNED |

## Review log (2026-07-07)

Codex adversarial challenge returned 4 critical / 7 high / 3 medium / 2 low.
Disposition:

- **Folded:** `stop` phase closing the dispatcher before pool disposal
  (C1); declared-vs-handled drift handled at bite time via E004 + reserved
  parity code E006 pending the kernel diagnostics write seam (C2, same
  deferral as http E003/E004); explicit `dbUrl: env.DB_URL` in all four
  migrations, env renames out of scope (C3, matched self-review); bus
  contract stated as strictly in-process synchronous dispatch, durable
  transport = `@arki/queue` recipe (C4, matched self-review); dynamic-path
  manifest invisibility documented + duplicate checks span both paths
  (H6); shared command/event id namespace + id = Emmett type string (H7,
  merged with the self-review id-derivation fix); zod subset + coded
  configure error E007 (H8); dependency-free `toDotAction` + no-dot import
  test (H9); v1 catalog scope excludes boot-bound read models (H10,
  matched self-review); dead-declaration limitation documented, E006
  reserved (H11); separate-pool/transaction-boundary docs (M12); E004 for
  no-handler dispatch (M13); error table expanded (M14); "read-model
  projections" doc phrasing (L15); pip version aligned with package
  version (L16 — verified: `dot.ts` hard-codes `0.1.0` against 0.1.5).
- **Rebutted:** H5 (projection module resolution "contradicts" DOT) —
  misreads the accepted actions RFC: specifiers resolve relative to the
  *app file*, so package specifiers resolve from the app's `node_modules`,
  which is precisely why the mechanism works for installed adapters.
- **Self-review additions (pre-Codex):** action id = type string, no
  static `streamPrefix` (boot-time function); composition chain
  es-features → `eventSourcing()` → http-features → `http()` with the
  mandated two-pip split for handle+expose features.

**Codex consult, post-acceptance (rev 4):** verdict READY-WITH-CHANGES —
no new contradiction from the rev-3 merge; architecture confirmed; all
remaining issues were exit-gate precision. Folded: Phase A now proves the
full shutdown sequence (in-flight drain before dispose, not just the E005
reject); Phase B proves manifest honesty (bundle-visible vs
dynamic-invisible) and exercises E007; Phase C requires explicit
`dbUrl: env.DB_URL` and one real ES command flow per migrated app in
integration/e2e; dynamic-path prose states outright that deprecated
dynamic handlers may execute commands absent from manifest and catalog.
Longevity guidance recorded: the most likely `action-meta@2` trigger is
first-classing sagas/process managers (a relationship graph, not a payload
schema) — queue-bridged commands and external subscribers do not force it.

## Resolved questions (founder decisions, 2026-07-07)

A. **Collection option name: `bundles`.** Exact symmetry with
   `http({ bundles })` — one collection concept across all adapters.
B. **Catalog format name: `event-catalog`.** Honest custom format; an
   AsyncAPI projection can be added later if a real consumer appears.
C. **Migration scope: all four backends in Phase C.** Founder chose the
   full sweep over the one-proving-ground recommendation — ordered
   smallest-first (loonyjobs → typeroom → everseek → brandability), with
   the first migration acting as the in-phase proving ground so gaps are
   fixed before the remaining three proceed.
D. **0.1.x options kept as the dynamic path.** `{ projections,
   commandHandlers }` stays accepted through 0.2.x — the escape hatch for
   runtime-computed handlers — deprecated in docs in favor of `bundles`.
