# RFC: Actions & projections — making `@arki/dot` a transport-agnostic kernel

- **Status:** ACCEPTED 2026-07-07 — all four recommendations approved by
  founder: (A) concept name `actions`, (B) `direction` required, (C) shims
  kept through 0.4.x and deleted in 0.5.0, (D) Phase 4 litmus = queue
  binding over `@arki/queue` + minimal `--as queue-topology` projection.
  Rev 2 after Codex adversarial challenge (4 critical / 6 high findings;
  all folded or rebutted, see Review log) and self-review. Rev 3 after a
  fresh-mind code-grounded review (4 findings + 4 minor notes, all folded,
  see Review log): Bun-first projection resolution, Phase 4 re-scoped +
  explicit release gate, `toJsonObject` narrowing helper, `snapshotVersion`
  on diagnostics.
- **Date:** 2026-07-07
- **Author:** Claude (session 548f7a6c), from the 2026-07-07 transport-coupling
  investigation
- **Depends on:** `@arki/dot` 0.3.0 (`registerRoute` schema fields, `dot explain
  --openapi`), `@arki/http` 0.0.1 (contracts, `contractMeta`, `toOpenApi`)
- **Related:** `docs/rfcs/2026-07-06-arki-http-adapter-and-request-scope.md`,
  `packages/dot/docs/principles.md`, `packages/dot/docs/adapter-authoring.md`
- **Location note:** this RFC is internal. It must NOT move into
  `packages/dot/docs/` — that tree mirrors to the public `arki-labs/arki` repo.

## Summary

`@arki/dot` claims to be a transport-agnostic composition kernel. It is not —
yet. The kernel's manifest hard-codes a `routes` section whose vocabulary
(`method`, `path`, `query`/`body` schemas, `streaming`) is OpenAPI's, its
configure context exposes `registerRoute`, and its CLI ships a full OpenAPI
3.1 renderer. A CLI-only app or a Kafka-only worker pays no runtime cost for
this, but the kernel privileges one interaction shape and every future
binding (queue, cron, CLI, WebSocket) would need kernel edits to be described
on equal footing.

This RFC removes the privilege with three moves:

1. **Actions replace routes.** The manifest's `routes` array becomes
   `actions` — a transport-neutral registry of boundary interactions:
   `{ id, pip, binding, direction, address?, summary?, meta? }`. All adapter
   vocabulary moves into the typed-JSON `meta` bag. An HTTP route, a Kafka
   consumer, a Kafka producer, a cron tick, and a CLI command are all
   actions.
2. **Projections replace the kernel OpenAPI renderer.** `render-openapi.ts`
   leaves the kernel. Adapters register a *projection* — a pointer to a pure
   `project(manifest)` module — and `dot explain --as openapi` (or `--as
   asyncapi`, `--as help-text`, …) imports and runs it. The kernel CLI never
   learns any adapter's document format again.
3. **Declarative authoring.** Pips declare `actions: [...]` next to `needs`,
   and contract objects satisfy a tiny structural protocol (`toDotAction()`).
   The imperative `registerRoutes(ctx, [...])` ceremony — and, for most
   pips, the `configure` hook itself — disappears.

Blast radius today is the smallest it will ever be: no file outside
`packages/dot` imports `RouteManifest`/`RouteTransport`; `@arki/http` feeds
`registerRoute` structurally via `contractMeta`; novelette/server is the only
consuming app. dot is 0.3.0, http is 0.0.1.

## Motivation

Three forcing observations from the 2026-07-07 investigation:

1. **The closed union.** `RouteTransport = 'http' | 'orpc' | 'trpc' | 'rpc'
   | 'custom'` (`manifest.ts:37`) is a kernel type adapters must ask
   permission to extend. A Kafka adapter describing "I consume
   `orders.created` with schema X" has no honest home — `method`/`path`
   don't map, and `transport: 'custom'` is a semantic shoehorn.
2. **The duplicated renderer.** The kernel CLI ships a complete OpenAPI 3.1
   generator (`cli/render-openapi.ts`) rendering from `manifest.routes`,
   while `@arki/http` already owns its own (`openapi.ts`, "falls out of the
   contracts"). Two renderers of the same document exist because the kernel
   needed one it should never have owned.
3. **The vocabulary leak is directional.** `@arki/http` converts zod → JSON
   Schema at configure time *so that the kernel's renderer can consume it*.
   The kernel defined `RouteManifest.input.query/body` for one adapter's
   benefit. A shape a second adapter cannot reuse was never generic.

The apps this blocks are real, not hypothetical: a CLI-only tool, a worker
that only consumes and publishes queue messages, a cron-driven batch app.
All of them deserve `dot explain`, `dot doctor`, and the manifest story on
equal footing with HTTP servers.

## Doctrine constraints (what shaped this design)

1. **Pips ARE the app; the kernel gains no transport knowledge** (principle
   2). After this RFC the kernel knows *that* apps interact with the world,
   never *how*.
2. **Deterministic by default** (principle 3). The actions table follows pip
   declaration order; `meta` is typed JSON produced at configure time;
   projections are pure functions of the manifest. Determinism comes from
   deterministic *construction* — the kernel does not re-sort or
   canonicalize keys.
3. **Agent-discoverable everywhere** (principle 4). Every binding's actions
   appear in `dot explain` with a universal `address` column; document
   formats (`--as openapi`) still render without booting; the manifest
   carries an explicit `manifestVersion` so machine consumers can detect the
   schema.
4. **Slightly playful, very precise** (principle 1). One word per concept:
   `action`, `binding`, `direction`, `address`, `projection`.
5. **Kernel has zero optional dependencies** (principle 5). Projections are
   import *specifiers* in the manifest, resolved **relative to the app
   file** by the CLI at render time — the kernel package depends on nothing
   new, and adapters keep `@arki/dot` as an optional peer (the action
   protocol is a plain method, no kernel import needed).

## Naming — why "action"

Survey of the landscape:

| Term | Who uses it | Why not |
| --- | --- | --- |
| route | HTTP frameworks | The word being evicted; meaningless for queues/CLI/cron |
| procedure | tRPC ("the P"), oRPC | Call/response-flavored; a Kafka producer or cron tick described as a "procedure" reads wrong; collides with what oRPC-mount `meta` genuinely contains |
| operation | OpenAPI (`operationId`), AsyncAPI 3.0, GraphQL | The most spec-aligned runner-up; neutral but bureaucratic; weaker developer mindshare than "action" |
| endpoint | Informal networking | Network-inbound-biased; awkward for producers, cron, CLI |
| **action** | **AsyncAPI 3.0's send/receive discriminator is literally named `action`**; server actions; GitHub Actions | — |

Decision: **action**, with `direction: 'in' | 'out'` resolving the only
genuine objection (an outbound publication is an action the app *performs*,
an inbound route is an action the world *requests*). The layering is clean:
the kernel says "action"; an adapter's own `meta` vocabulary may say
"procedure" or "route" internally. Runner-up recorded: `operation`
(founder question A).

## Design — Part 1: the action model

### `ActionManifest` — neutral core, adapter-owned detail

The kernel gains a real JSON type — `meta: Record<string, unknown>` is not a
serializable contract, and the manifest's `--json` output must never be
lossy:

```ts
/** JSON-serializable value — the manifest's currency. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Direction of a boundary interaction, viewed from the app. */
export type ActionDirection = 'in' | 'out';

/** Something the app does at a boundary — universal, serializable, tiny. */
export type ActionManifest = {
  /** Stable identifier, e.g. 'orders.list', 'orders.created.consume'. */
  id: string;
  pip: string;
  /**
   * Adapter-owned binding name: 'http', 'queue', 'cli', 'cron', 'orpc',
   * 'trpc', … Open string — well-known values are documented in
   * `adapter-authoring.md`, never enforced. Third-party bindings MUST be
   * package-qualified ('acme:bus') to avoid collisions with well-known
   * names. The closed RouteTransport union was the original sin.
   */
  binding: string;
  /** 'in' = the world invokes/feeds the app; 'out' = the app emits. */
  direction: ActionDirection;
  /**
   * Universal DISPLAY string: 'GET /health', 'orders.created',
   * 'db migrate', '0 3 * * *'. What `dot explain` prints; adapters own the
   * format per binding. Display and human identity only — machine
   * consumers compare `id` and read `meta`, never parse `address`.
   */
  address?: string;
  /** Human summary, rendered into explain output and projected documents. */
  summary?: string;
  /**
   * Adapter-owned detail, typed JSON, opaque to the kernel. `@arki/http`
   * stores { method, path, input, output, streaming } here; a queue
   * adapter stores { topic, message, groupId }; the kernel never reads it.
   */
  meta?: Readonly<JsonObject>;
  /**
   * Optional identifier+version of the meta layout, e.g.
   * '@arki/http/action-meta@1'. Projections SHOULD verify it before
   * reading `meta`, so a foreign adapter reusing a well-known binding
   * name mis-renders loudly instead of silently.
   */
  metaSchema?: string;
};
```

Examples across bindings:

| App shape | Action |
| --- | --- |
| HTTP route | `{ id: 'orders.list', binding: 'http', direction: 'in', address: 'GET /orders', meta: { method, path, input, output } }` |
| Kafka consumer | `{ id: 'orders.ingest', binding: 'queue', direction: 'in', address: 'orders.created', meta: { message } }` |
| Kafka producer | `{ id: 'invoices.publish', binding: 'queue', direction: 'out', address: 'invoices.issued', meta: { message } }` |
| CLI command | `{ id: 'db.migrate', binding: 'cli', direction: 'in', address: 'db migrate' }` |
| Cron job | `{ id: 'reports.nightly', binding: 'cron', direction: 'in', address: '0 3 * * *' }` |

**Duplex transports** (WebSocket, bidirectional streams, request/reply
queues) are modeled as **two actions sharing one `address`** — one `in`, one
`out` — exactly as AsyncAPI 3.0 models duplex channels as separate
send/receive operations. `direction` deliberately has no `'inout'`: a value
that means "both" reintroduces the vagueness the field exists to kill, and
the two-entry pattern gives each side its own `meta` (subscribe schema ≠
publish schema).

**Identity rules:**

- `id` MUST be unique **within a binding**. A duplicate `(binding, id)` pair
  is an error-severity kernel issue (`DOT_LIFECYCLE_E016`) — the manifest
  stays total (both entries render) but `dot doctor` fails.
- The same `id` **across bindings** is legal and meaningful: one logical
  operation exposed over two transports (`orders.create` as an HTTP route
  and a queue consumer).

**Serializability is enforced, not requested:** `registerAction` (and the
declarative path) run a JSON round-trip check at configure time — configure
runs once, actions are small, the cost is nil. The check is a deep-equal of
`JSON.parse(JSON.stringify(meta))` against the original: `Date` coercion,
dropped functions/`undefined` members, and `NaN`/`Infinity` → `null` all
fail the comparison; cycles fail at `stringify` itself. Those five cases
ARE the kernel test matrix (Rev 3 — equality semantics pinned). A failing
`meta` raises an error-severity issue (`DOT_LIFECYCLE_E017`) naming the
offending pip and action id. `--json` output is never silently lossy.

**The kernel also exports a checked narrowing helper —
`toJsonObject(value: unknown): JsonObject`** (Rev 3 finding). Without it,
every adapter hits the same wall: `z.toJSONSchema` returns
`Record<string, unknown>`, which is NOT assignable to `JsonObject`
(`unknown` never narrows to `JsonValue`), and the only exit is an
`as unknown as JsonObject` cast — banned workspace-wide. The helper runs
the same round-trip check as E017 and narrows the type, so validation and
narrowing are one operation at the adapter seam; E017 at registration
becomes the backstop instead of the only line of defense.

### Manifest and diagnostics shape

`DotAppManifest` goes from five arrays to **six**, and gains an explicit
schema version so machine consumers of `dot explain --json` detect the
change instead of silently reading a missing `routes` key:

```ts
export type DotAppManifest = {
  /** Manifest schema version. 1 = the routes era (implicit); 2 = this RFC. */
  manifestVersion: 2;
  app: { name: string; version?: string };
  pips: PipManifest[];
  actions: ActionManifest[];        // was: routes: RouteManifest[]
  services: ServiceManifest[];
  lifecycle: LifecycleManifest[];
  dependencies: DependencyEdge[];
  projections: ProjectionManifest[]; // new — Part 2
};
```

The "N arrays" contract keeps its meaning — *empty is empty, but never
missing* — with N amended from 5 to 6 (scorecard reference updated).
`DotDiagnosticsSnapshot` stays at five arrays with `routes: RouteDiagnostic[]`
becoming `actions: ActionDiagnostic[]`, and gains the same version marker
the manifest got — `snapshotVersion: 2` — because `dot doctor --json`
undergoes the identical silent rename and its machine consumers deserve
the same detection signal (Rev 3 finding: H9's remedy had been applied
asymmetrically to one of the two renamed surfaces):

```ts
export type ActionDiagnostic = {
  id: string;
  pip: string;
  binding: string;
  status: Extract<DiagnosticStatus, 'ok' | 'degraded' | 'failed'>;
  issues: DiagnosticIssue[];
};
```

`ActionDiagnostic.status` is **structural only**: it mirrors the owning
pip's configure-phase health (exactly as `RouteDiagnostic` does today). It
is not runtime health — whether a queue consumer is lagging or an HTTP
listener is up belongs to boot/runtime diagnostics, out of scope here. The
field's docs say so, so adapters don't try to smuggle liveness into it.

### Registration — declarative first, imperative still available

**Declarative (the new front door).** Pip definitions gain `actions`,
sitting next to `needs` — the pip's boundary surface is visible at the
definition site, not buried in a hook body:

```ts
/** What a pip declares: everything but the kernel-stamped pip name. */
export type ActionDeclaration = Omit<ActionManifest, 'pip'>;

/** Structural protocol — same species as the kernel's witness pattern. */
export type ActionSource = ActionDeclaration | { toDotAction(): ActionDeclaration };

// pip definition:
export const serverInfo = pip('server-info', {
  needs: { queues: QueueStatus },
  actions: [rootInfo, health, queueStatus],  // contracts ARE the declaration
  boot(ctx) { /* … */ },
});
```

The protocol method is `toDotAction()` — deliberately not a generic
`toAction()`, so an unrelated object with an `actions`-shaped method can't
structurally satisfy it by accident. A well-known-symbol protocol
(`Symbol.for('arki.dot.action')`) was considered and rejected: `Symbol.for`
types poorly, and the distinctive method name achieves the same collision
resistance while keeping `@arki/dot` an optional peer for adapters (a plain
method needs no kernel import).

The kernel collects `actions` during the configure phase (declared entries
first, in array order, before the `configure` hook — if any — runs), calls
`toDotAction()` where present, stamps `pip`, validates (identity +
serializability rules above), and appends to the same per-pip record. A
throwing `toDotAction()` maps to the existing configure-failure path
(`DOT_LIFECYCLE_E002` issue semantics). Collection runs for **every** pip,
including pips with no `configure` hook — and declarative-only pips are NOT
marked as configure participants in `manifest.lifecycle` (declaring data is
not running a hook).

Anything with `toDotAction(): ActionDeclaration` qualifies: `route.get(...)`
contracts implement it in `@arki/http`; a future `topic.consume(...)`
implements it in a queue adapter. Adding binding #7 requires zero kernel
edits — the same way a new iterable never requires a change to `for…of`.

This gives the pip definition a three-part symmetry: `needs` (what I consume
from the wire), `actions` (how the world and I interact at boundaries),
`provides` (what I publish inward — capability strings stay what they are:
informational, inward-facing; boundary interactions now have a proper home
and should not be encoded as `provides` strings). The `configure` hook
shrinks back to what it was meant for — rare dynamic registration — instead
of mandatory ceremony.

**Imperative (kept for dynamic cases).** `DotConfigureContext` gains
`registerAction(decl: ActionDeclaration): void`. Both paths land in the same
record; ordering is declared-then-registered, stable.

**Deprecated shim.** `registerRoute` survives through 0.4.x, deleted in
0.5.0. It builds `meta` **conditionally** — spreading `undefined`-valued
keys would make in-memory and JSON views of the manifest disagree:

```ts
registerRoute({ id, method, path, transport, description, input, output, streaming }) {
  const meta: JsonObject = {};
  if (method !== undefined) meta['method'] = method;
  if (path !== undefined) meta['path'] = path;
  if (input !== undefined) meta['input'] = input;
  if (output !== undefined) meta['output'] = output;
  if (streaming !== undefined) meta['streaming'] = streaming;
  registerAction({
    id,
    binding: transport,
    direction: 'in',
    ...(path === undefined ? {} : { address: `${method ?? 'GET'} ${path}` }),
    ...(description === undefined ? {} : { summary: description }),
    ...(Object.keys(meta).length === 0 ? {} : { meta }),
  });
}
```

(`GET` is the explicit default exactly where the legacy OpenAPI renderer
defaulted it.) Legacy `transport: 'custom'` maps to `binding: 'custom'` —
a bare name that violates this RFC's own namespacing rule. It is
grandfathered as shim-era-only: `adapter-authoring.md` documents `custom`
as never claimable by a real binding, and it dies with the shim in 0.5.0
(Rev 3 minor note). The shim deliberately does NOT stamp `metaSchema` — the
kernel cannot assert another package's schema identity (self-review
finding). Only `@arki/http`'s own `toDotAction()` claims
`'@arki/http/action-meta@1'`; the http projection accepts a missing
`metaSchema` on `binding: 'http'` actions through the 0.4.x deprecation
window (shim-era registrations), then requires it from 0.5.0. The `meta`
key layout is *the* stable contract between `@arki/http` and its
projection — documented in `adapter-authoring.md` as
`@arki/http/action-meta@1`. Note: the deleted `RouteManifest`/
`RouteTransport` **types** have no shim — type-level importers break at
0.4.0 and the changelog says so explicitly.

### CLI rendering — one table for every binding ever invented

`dot explain` renders actions with universal columns, zero binding
knowledge, plus a section for registered projections:

```text
Actions (5)
  ID                BINDING  DIR  ADDRESS                    PIP
  orders.list       http     in   GET /orders                orders
  orders.create     http     in   POST /orders               orders
  orders.ingest     queue    in   orders.created             order-ingest
  invoices.publish  queue    out  invoices.issued            billing
  reports.nightly   cron     in   0 3 * * *                  reports

Projections (1)
  FORMAT   BINDING  MODULE                  PIP
  openapi  http     @arki/http/projection   http
```

`dot doctor` renders the `actions` diagnostics section the same way
(`ID | BINDING | STATUS`).

## Design — Part 2: projections

### The mechanism

A projection is a manifest entry pointing at a pure rendering module:

```ts
export type ProjectionManifest = {
  /**
   * Document format key — what `--as <format>` matches. Well-known formats
   * ('openapi', 'asyncapi') are documented in `adapter-authoring.md`;
   * third-party formats MUST be package-qualified ('acme:catalog').
   */
  format: string;
  /** Which binding it projects. Informational (errors/help text only) — not a filter the kernel enforces. */
  binding?: string;
  /** Import specifier resolving to a module exporting `project`. */
  module: string;            // e.g. '@arki/http/projection'
  pip: string;
};

// DotConfigureContext:
registerProjection(decl: Omit<ProjectionManifest, 'pip'>): void;
```

The projection module's contract:

```ts
/**
 * MUST be pure and deterministic: same manifest → identical result. Purity
 * is a documented contract, not a kernel-enforced sandbox — the kernel
 * guarantees the MANIFEST is deterministic; a projection that reads the
 * clock or the filesystem forfeits its own byte-identical claim. Official
 * @arki projections carry golden-output tests as proof.
 */
export function project(manifest: DotAppManifest): JsonValue;
```

`@arki/http`'s bundle pip registers its own in `configure`:

```ts
ctx.registerProjection({ format: 'openapi', binding: 'http', module: '@arki/http/projection' });
```

### `dot explain --as <format>`

Flow: discover app → run `configure` (no boot, exactly as today) → find the
projection whose `format` matches → dynamic-import `module` → call
`project(manifest)` → print. Plain mode prints string results **verbatim**
(a `help-text` projection must not emit a JSON-quoted string) and everything
else as JSON; `--json` wraps either in the standard envelope as
`data: { format, document }`, preserving today's `OpenApiData` shape.

**Module resolution — the critical detail:** the specifier is resolved
**relative to the discovered app file**, not the CLI package. The adapter
that registered the projection is by definition a dependency of the *app*,
not of `@arki/dot` — resolving from the kernel's own module graph would
only work under hoisted `node_modules` and would break under pnpm-style
isolation, quietly recreating the adapter coupling this RFC deletes.

The mechanism is specified against the runtimes the CLI actually has
(Rev 3 finding — the Rev 2 prescription, two-argument
`import.meta.resolve(specifier, parent)`, is still behind
`--experimental-import-meta-resolve` in Node and must not be load-bearing;
unflagged single-argument `import.meta.resolve` resolves from the CLI's
own graph, which is exactly the bug this paragraph exists to prevent):

1. **Bun (primary):** `Bun.resolveSync(specifier, dirname(appFilePath))`.
   The CLI already runs under Bun — that is why `cli/discover.ts` can
   import `.ts` app files natively.
2. **Node (fallback):** `createRequire(appFilePath).resolve(specifier)`.
   Resolves subpath exports under require-flavored conditions (`node`,
   `require`, `default`) — which works for `@arki/http/projection` because
   its export map carries a `default` condition.

Consequence, promoted to a hard authoring rule in `adapter-authoring.md`:
**projection subpath exports MUST include a `default` condition.** An
ESM-only export map (`import` condition alone) resolves under Bun but
throws `ERR_PACKAGE_PATH_NOT_EXPORTED` under the Node fallback — a
correctly-registered projection would then mis-report as `DOT_CLI_E009`.

Failure handling, all coded:

| Condition | Behavior |
| --- | --- |
| No projection for the requested format | `DOT_CLI_E008` — remediation lists registered formats, or names the adapter to `.use()`. A CLI-only app asking for `--as openapi` gets exactly this: correct, not degraded. |
| Import fails / no `project` export | `DOT_CLI_E009` — names the failing specifier, the resolved URL, the registering pip, and the `--module` debug override. |
| `project()` throws, or returns a value that fails the JSON round-trip | `DOT_CLI_E010` — execution/output failure, distinct from import failure. |
| Two projections, same `format`, **different** `module` | `DOT_CLI_E011` — hard error at `--as` time naming both pips. Shadowing a document renderer via registration order is a bug, not a merge strategy. Identical `(format, module)` pairs dedupe silently. `explain`/`doctor` default output stays total — the conflict only errors when that format is requested. |

`--as <format> --module <specifier>` overrides the registered module for
one invocation — the debugging escape hatch when a projection is broken or
mis-exported (Rev 3 minor note). Per-invocation only; nothing persists.

`--openapi` survives 0.4.x as a deprecation-warning alias for
`--as openapi`, deleted in 0.5.0.

**Trust boundary note:** the CLI already dynamic-imports the entire app file
(`cli/discover.ts`) — importing a module specifier *placed in the manifest by
that same code* adds no new trust boundary.

### What this buys

`--as` becomes an open ecosystem seam. A queue adapter ships
`--as asyncapi`. A CLI adapter ships `--as help-text`. `render-openapi.ts`
(148 lines of OpenAPI knowledge inside the kernel) is deleted, and the two
existing OpenAPI generators collapse into the one `@arki/http` already owns.

## Changes by package

### `@arki/dot` 0.4.0

1. `manifest.ts`: `JsonValue`/`JsonObject` + the `toJsonObject(value:
   unknown): JsonObject` checked-narrowing helper, `ActionManifest`,
   `ActionDirection`, `ProjectionManifest`; `DotAppManifest.actions` +
   `.projections` + `manifestVersion: 2`; `RouteManifest`/`RouteTransport`
   deleted (0.x minor; runtime shims cover call sites, type deletions called
   out in the changelog).
2. `pip-contract.ts`: `registerAction`, `registerProjection`,
   `ActionDeclaration`, `ActionSource`; `registerRoute` deprecated shim
   (conditional meta, explicit `GET` default).
3. `pip.ts`: `actions?: readonly ActionSource[]` on the pip definition.
4. `kernel/app-instance.ts`: per-pip `actions` records; declared-actions
   collection in the configure phase (runs for hook-less pips, no phantom
   `configure` lifecycle entry); manifest/diagnostics assembly; identity
   validation (`DOT_LIFECYCLE_E016`: duplicate `(binding, id)`, error) and
   serializability validation (`DOT_LIFECYCLE_E017`: meta fails JSON
   round-trip, error).
5. `diagnostics.ts`: `ActionDiagnostic` (status documented as structural
   only); snapshot member rename + `snapshotVersion: 2`.
6. CLI: actions + projections tables in `render-explain.ts` /
   `render-doctor.ts`; delete `render-openapi.ts`; `--as <format>` with
   the app-file-relative Bun-first/Node-fallback resolution chain
   (`Bun.resolveSync` → `createRequire(appFilePath).resolve`), the
   `--module` debug override, and `DOT_CLI_E008`–`E011`;
   string-vs-JSON plain printing; `--openapi` alias.
7. Docs: `adapter-authoring.md` gains "authoring a binding" as the central
   chapter — binding naming rules (well-known registry; package-qualified
   third-party names; `custom` marked shim-era-only, never claimable), meta
   schema versioning (`metaSchema`), projection purity contract +
   golden-test requirement, the projection-subpath `default`-condition
   requirement, format naming rules.

### `@arki/http` 0.1.0

1. Contracts implement `toDotAction()` (today's `contractMeta`, retargeted):
   binding `'http'`, direction `'in'`, address `'${method} ${path}'`,
   `metaSchema: '@arki/http/action-meta@1'`, meta
   `{ method, path, input, output, streaming }` built conditionally — the
   JSON Schema values pass through the kernel's `toJsonObject` helper, no
   casts (`z.toJSONSchema` returns `Record<string, unknown>`, which never
   narrows to `JsonObject` on its own). SSE contracts set
   `streaming: true`. OpenAPI distinguishes `summary` vs `description` —
   the kernel field stays `summary`; the meta schema reserves both keys so
   the distinction survives projection.
2. `bind.mount(path, handler, { transport, id })` → the mounted action's
   binding is the former transport string (`'orpc'`, `'trpc'`, `'custom'`);
   `address` is the mount path prefix verbatim (e.g. `/rpc`) — display-only
   like every address — and `meta` carries `{ path }` (Rev 3 minor note:
   previously unspecified).
3. New export **`@arki/http/projection`**: `project(manifest)` → OpenAPI 3.1
   document, built from `binding === 'http'` actions after verifying
   `metaSchema`. Ports the deleted kernel renderer's logic; shares the
   operation builder with `toOpenApi` (one OpenAPI generator, two entry
   points: contracts-in, manifest-in). Carries a golden-output determinism
   test.
4. `http()` pip auto-registers the projection in `configure`.
5. `registerRoutes(ctx, contracts)` deprecated → alias over
   `ctx.registerAction(contract.toDotAction())`; removal with dot 0.5.0.
6. Peer range bumps to `@arki/dot@^0.4.0` (cascade republish per release
   doctrine — note `^0.3.0` does not admit 0.4.0 on the 0.x line, so the
   http republish ships in the same wave).

### Apps

`apps/novelette/server` — the only consumer. `server-info.ts` drops its
`configure` hook:

```ts
// before
configure(ctx) {
  registerRoutes(ctx, [rootInfo, health, queueStatus]);
},

// after (no configure hook at all)
actions: [rootInfo, health, queueStatus],
```

Template-sync rule applies: if any `turbo/generators/templates/application/`
file references `registerRoutes`, it moves to `actions:` in the same change.

## The litmus test — a second binding or it didn't happen

An abstraction generalized from one consumer is a guess. Phase 4 builds the
real second binding: a **queue binding over `@arki/queue`** (novelette
already runs queue workers). Worker registrations declare
`direction: 'in'` actions; enqueue-capable producers declare
`direction: 'out'`; address = queue/topic name; own `metaSchema`.

**Scope honesty (Rev 3):** this is not one table row of work. HTTP got its
actions for free because `route.get(...)` contracts are already static
data; `@arki/queue` has no equivalent. Novelette's queue topology is
assembled dynamically inside `startQueueRuntime(buildRuntimeConfig(kv))`,
fired un-awaited from the pip's `start` hook with graceful degradation
(`apps/novelette/server/src/pips/queue-runtime.ts`) — nothing exists at
configure time to derive actions from. Phase 4's first deliverable is
therefore a **declarative topology surface for the queue adapter** (the
queue-side sibling of `route.get(...)`). That is a feature of the litmus,
not an inconvenience: a dynamic, degradeable, boot-time consumer stresses
exactly the assumption HTTP never tested — that configure-only
`registerAction` suffices. If queue topology turns out to be knowable only
at boot, that is a finding about the action model's registration timing,
and we fix the model, not the adapter.

The litmus MUST include a minimal **queue projection** (`--as
queue-topology`: topics × consumers/producers as JSON) — table display alone
would leave the riskiest seam, adapter-owned document generation from opaque
`meta`, untested by a second consumer. Exit criterion:

> **The kernel diff for the second binding is zero lines.**

If the queue adapter needs a single kernel edit to describe itself, the
action model failed and we fix the model, not the adapter.

## Rejected alternatives

- **Fully-open manifest sections ("facets for anything").** Namespaced
  arbitrary sections trade the kernel's strongest asset — a stable, typed,
  tooling-friendly schema — for flexibility nothing currently needs.
  Actions + projections cover the demonstrated cases; revisit only if a
  third *kind* of manifest data (not a third binding) ever appears.
- **Keep `routes`, add parallel `channels`** (the OpenAPI/AsyncAPI
  two-concept split). Two registries, two explain tables, two diagnostic
  arrays — and a third registry the day a CLI binding lands. One concept
  with `direction` is strictly smaller and the AsyncAPI 3.0 precedent shows
  it suffices.
- **`direction: 'inout'` for duplex transports** (Codex challenge H6).
  Rejected: AsyncAPI 3.0 itself models duplex as separate send/receive
  operations; a "both" value re-blurs the field and forces one `meta` to
  describe two message flows. Duplex = two actions, one `address` —
  documented in Part 1.
- **Structured `locator` field alongside `address`** (Codex challenge H10).
  Rejected: binding-owned structured data is exactly what `meta` is; a
  second structured home splits one concept across two fields. Fixed
  instead by documenting `address` as display-only.
- **Compatibility `routes` array in `--json` output** (Codex challenge H9).
  Rejected: a derived HTTP-shaped view in every manifest would keep the
  HTTP privilege alive under a flag. Fixed instead with `manifestVersion: 2`
  so consumers detect the schema change explicitly.
- **Closed `binding` union with `'custom'`.** Repeats the `RouteTransport`
  mistake this RFC exists to fix. Open string, documented well-known values,
  and mandatory package-qualification for third parties.
- **`operation` / `procedure` / `endpoint` naming.** See the naming survey.
  `procedure` is disqualified (RPC-flavored, collides with adapter-internal
  vocabulary); `endpoint` is inbound-network-biased; `operation` remains the
  recorded runner-up (question A).
- **Well-known-symbol action protocol** (`Symbol.for('arki.dot.action')`).
  Types poorly; the distinctive `toDotAction` method name achieves the same
  collision resistance with zero machinery and no kernel import in adapters.
- **Projection discovery via well-known subpath convention**
  (`<pkg>/dot-projection` probed by the CLI). Auto-discovery violates
  determinism/explicitness doctrine — it is controller-scanning with extra
  steps. Manifest registration keeps every projection declared, attributable
  to a pip, and visible in `dot explain`.
- **Registering renderer *functions* instead of module specifiers.**
  Functions can't survive the manifest's "plain serializable data" contract
  and would force projections to run inside `configure`. Specifiers keep the
  manifest data-only and defer code loading to the one consumer that needs
  it (the CLI).
- **Doing nothing.** Zero runtime cost today, but every future binding
  either goes undescribed (invisible to `dot explain`/`doctor`/agents) or
  waits on a kernel PR. The whole point of the manifest is that it describes
  the app; a manifest that can only describe HTTP apps quietly narrows what
  DOT is for.

## Delivery plan

Phases 1–3 **merge as one unit** — Phase 2 removes the kernel's OpenAPI
renderer and Phase 3 ships its replacement, so landing them apart would
leave a window with no OpenAPI story (self-review finding). **Publishing
is a separate, later event: the npm wave (Phase 5) is gated on Phase 4's
zero-line-kernel-diff exit criterion** (Rev 3 — previously ambiguous). If
the litmus forces a model change, it lands as workspace-only edits before
anything ships. 0.4.0 must never reach npm with an untested action model —
"fix the model, not the adapter" after publishing would cost a second
breaking minor immediately after the first.

| Phase | Contents | Exit criterion | Status |
| --- | --- | --- | --- |
| 1 | Kernel action model: `JsonValue`/manifest/diagnostics types, `registerAction`/`registerProjection`, declarative `actions:` protocol, shims, E016/E017 validation, tests | `manifest.actions` populated via both paths in kernel tests; shim proven lossless (every legacy `registerRoute` field lands in the action or its `meta`) | PLANNED |
| 2 | CLI: actions + projections tables, `--as <format>` with app-file-relative resolution, delete `render-openapi.ts`, `DOT_CLI_E008`–`E011`, `--openapi` alias | `dot explain` on novelette shows both tables; alias warns | PLANNED |
| 3 | `@arki/http` 0.1.0: `toDotAction()` on contracts, `./projection` export + golden test, auto-registration, `registerRoutes` deprecation; migrate novelette/server | novelette runs on `actions:` declarations; `--as openapi` output equivalent to 0.3.0's `--openapi` for the same app (golden diff); typecheck + e2e green | PLANNED |
| 4 | Litmus binding: declarative queue-topology surface in `@arki/queue` (the `route.get(...)` sibling), queue actions (in/out) in novelette + minimal `--as queue-topology` projection | **zero-line kernel diff**; queue actions visible in `dot explain` next to http ones; second projection renders from queue `meta` | PLANNED |
| 5 | Docs + release: `adapter-authoring.md` binding chapter, CHANGELOGs (type deletions called out), coordinated wave (dot 0.4.0 + http 0.1.0 + peer cascade) via arki-release — **publish gated on Phase 4's exit criterion** | scorecard PASS; mirror synced | PLANNED |

Versioning: 0.x minors may break (semver spec item 4); shims still soften the
one published consumer. `registerRoute` and `--openapi` are deleted in dot
0.5.0.

## Review log — Rev 2 (2026-07-07, Codex adversarial challenge)

Codex adversarial challenge returned 4 critical / 6 high / 5 medium / 2 low.
Disposition:

- **Folded:** app-file-relative projection resolution (C1); `JsonValue`-typed
  `meta` + configure-time round-trip validation, E017 (C2); binding/format
  namespacing rules + optional `metaSchema` (C3, M13); duplicate-format hard
  error E011 (C4, tightened from first-wins); documented purity contract +
  golden tests (H5); duplicate `(binding, id)` escalated to error severity
  E016 (H7 — cross-binding same-id stays legal: one logical operation, two
  transports); conditional shim meta + explicit `GET` default (H8);
  `manifestVersion: 2` (H9); `toDotAction()` rename (M11); execution-failure
  code E010 (M12); queue projection added to litmus (M14); structural-only
  diagnostics status (M15); projections `binding` documented informational
  (L16); `summary`/`description` reserved in http meta schema (L17).
- **Rebutted:** `'inout'` direction (H6) and structured `locator` (H10) —
  see Rejected alternatives; compatibility `routes` array (H9's alternative
  remedy) — replaced by `manifestVersion`.
- **Self-review additions:** phases 1–3 single-wave constraint; verbatim
  string printing in plain mode; projections section in explain; changelog
  callout for type deletions; hook-less collection without phantom
  lifecycle entries; `provides`-vs-`actions` seam clarification; kernel
  shim must not stamp `@arki/http`'s `metaSchema` (layering leak — the http
  projection tolerates its absence through 0.4.x instead).

## Review log — Rev 3 (2026-07-07, fresh-mind code-grounded review)

A second independent review pass, findings verified against the code
(grep confirmed the blast-radius claim — zero importers of
`RouteManifest`/`RouteTransport` outside `packages/dot`; the two OpenAPI
builders confirmed near line-for-line duplicates). Four findings + four
minor notes, all folded:

- **R3-1 (critical, folded):** projection module resolution prescribed an
  API that does not work on the named runtimes — two-argument
  `import.meta.resolve` is behind `--experimental-import-meta-resolve` in
  Node, and the CLI actually runs under Bun (`cli/discover.ts` imports
  `.ts` app files natively). Replaced with the Bun-first/Node-fallback
  chain (`Bun.resolveSync(specifier, dirname(appFilePath))` →
  `createRequire(appFilePath).resolve`) plus a hard authoring rule:
  projection subpath exports MUST include a `default` condition.
- **R3-2 (high, folded):** Phase 4 litmus under-scoped — `@arki/queue` has
  no static topology surface; novelette assembles its workers dynamically
  at `start` with graceful degradation. Litmus re-scoped to include the
  declarative topology layer and explicitly framed as a stress test of
  configure-only registration timing. Release gate made explicit: the npm
  wave publishes only after the zero-line-kernel-diff exit criterion
  passes.
- **R3-3 (high, folded):** `JsonValue` typing creates cast pressure —
  `z.toJSONSchema` output (`Record<string, unknown>`) is not assignable to
  `JsonObject`, and the only workaround is the workspace-banned
  `as unknown as` cast. Kernel now exports `toJsonObject`: one operation
  that validates (same check as E017) and narrows; E017 becomes the
  backstop.
- **R3-4 (medium, folded):** H9's version-marker remedy was applied
  asymmetrically — the manifest got `manifestVersion: 2` but the equally
  renamed `DotDiagnosticsSnapshot` got nothing. `snapshotVersion: 2` added.
- **Minor notes (folded):** shim's `binding: 'custom'` grandfathered as
  shim-era-only in `adapter-authoring.md` (it violates the RFC's own
  namespacing rule; dies in 0.5.0); `bind.mount` action `address`
  specified (mount path prefix verbatim, `meta: { path }`); E017 equality
  semantics pinned (deep-equal of `JSON.parse(JSON.stringify(x))` vs `x`;
  five-case test matrix); `--as <format> --module <specifier>` debug
  override added, named in `DOT_CLI_E009` remediation.

## Resolved questions (founder decisions, 2026-07-07)

A. **Concept name: `actions`.** Direction-neutral once `direction` exists,
   AsyncAPI precedent, strongest developer mindshare. Runner-up
   `operations` recorded in the naming survey.
B. **`direction` is required.** Every declaration self-documents; adapters
   set it inside `toDotAction()`, so app authors rarely type it by hand.
C. **Shims live through 0.4.x, deleted in 0.5.0.** `registerRoute` and
   `--openapi` stay as deprecated aliases for one minor — dot 0.3.0 is
   published and unknown external adopters get one migration window.
D. **Phase 4 litmus: queue binding + projection.** Queue actions (in/out)
   over `@arki/queue` in novelette plus a minimal `--as queue-topology`
   projection — exercises `direction: 'out'` AND the adapter-owned
   rendering seam. Exit gate stands: zero-line kernel diff.

(Resolved during review, no longer open: projections live as a sixth
top-level manifest array — consistent with the "arrays, never missing"
contract and visible in explain; the alternative of nesting under `app`
hid an extension seam that deserves visibility.)
