# @arki/dot

> Compose an app from typed units. The compiler checks the wiring. The kernel boots the units in declaration order and disposes them in reverse.

A Dot app is a chain of units. Each unit has a role: infra (a database, a
cache, a mailer), features (your domain), or entrypoints (an HTTP server, a
worker, a scheduler). Each unit says what it needs, what it provides, and
what to do at each of five lifecycle hooks: `configure`, `boot`, `start`,
`stop` and `dispose`. Infra boots first, then features, then entrypoints.
There is no hidden core: remove every unit and nothing is left. The units
are the app.

```text
defineApp('acme')  .infra(database)  .infra(stripe)  .start()
                        │               │
     boot / start:      1st ──────────▶ 2nd
     stop / dispose:    2nd ◀────────── 1st
```

## Install

```sh
bun add @arki/dot
# or
npm install @arki/dot
```

The `dot` command ships in the same package.

## Quick start

```ts run
import { defineApp, infra } from '@arki/dot';
import { isFailure } from '@arki/failure';

// Stand-ins for your real database and Stripe clients.
type Db = { query(sql: string): Promise<unknown[]>; close(): Promise<void> };
const openDb = async (url = 'memory://'): Promise<Db> => ({ query: async sql => [url, sql], close: async () => {} });
const makeStripeClient = (db: Db) => ({ charge: (cents: number) => db.query(`charge ${cents}`) });

const database = infra({
  name: 'database',
  provides: {
    db: () => openDb(process.env.DATABASE_URL), // ← one factory per key; may be async
  },
  async dispose({ db }) {
    await db.close();
  },
});

const stripe = infra({
  name: 'stripe',
  needs: { db: database.provides.db }, // typed handle — destructure in hooks
  configure(ctx) {
    // Validate config, register schemas, no I/O.
    ctx.registerService('stripe', 'custom');
  },
  provides: {
    stripe: ({ db }) => makeStripeClient(db), // factories see the needs
  },
  async boot({ stripe }) {
    await stripe.charge(0); // side effects only (seed, warm-up). Returns nothing.
  },
  async start({ stripe }) {
    await stripe.charge(0); // begin processing — workers, subscriptions, schedulers.
  },
  async stop({ db }) {
    await db.query('select 1'); // stop processing — drain workers, unsubscribe.
  },
});

const app = await defineApp('acme')
  .infra(database, stripe) // providers before consumers — enforced at compile time
  .start();
if (isFailure(app)) throw new Error(app.code);

// app.manifest, app.diagnostics — agent-friendly envelopes.
const order = app.manifest.plugins.map(p => p.name).join(' → ');
if (order !== 'database → stripe') throw new Error(`units boot in declaration order, got ${order}`);

await app.stop();
await app.dispose();
```

There is no registry to configure, no decorators, no reflection. The `needs`
shape is the injection contract; the `provides` factories are the provision
contract; the builder's type-level guard connects the two.

The [Quickstart](./docs/quickstart.md) builds a small app step by step,
breaks it on purpose, and reads the error with `dot explain` and `dot doctor`.

## When not to use this

- **You need a web server or a router.** Dot composes services. Serve HTTP
  with TanStack Start, Hono or oRPC, and mount the server as a unit.
- **You want units loaded from disk or from config.** Dot never
  auto-loads. The app is the `.infra()` chain that the compiler reads.
- **The program has one or two services.** A function with `try`/`finally`
  is shorter. Dot pays off when several packages bring services with their
  own setup and teardown.
- **You need a scope per request.** Dot has one service graph per app. Keep
  per-request values in your router's context.

## Runtime support

The portable entries (`@arki/dot`, `@arki/dot/unit`, `@arki/dot/feature`, `@arki/dot/log`, `@arki/dot/test-harness`) run on Node, Bun, Deno, browsers and Hermes (React Native). The kernel reads `process`, `performance` and timers at call time, never at import, and falls back where the runtime has none: `hookSignals` hooks nothing without a `process`, and durations use `Date.now()` without `performance`.

The adapter entries need more:

| Entry                                | Needs                            | Why                               |
| ------------------------------------ | -------------------------------- | --------------------------------- |
| `@arki/dot/cli` and the `dot` binary | Node or Bun                      | Reads files, spawns processes.    |
| `@arki/dot/orpc`                     | the optional `@orpc/server` peer | Wraps oRPC procedures as actions. |

`bun run test:runtimes` boots a small app through the portable API on every leg, from the built `dist/`.

## Public imports

| Import                   | What it gives you                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `@arki/dot`              | `defineApp`, `infra`, `entrypoint`, `service`, `token`, `lazy`, `rename`, `hookSignals`, `reportErrors`, `logHandlers`, the errors and the manifest types. |
| `@arki/dot/unit`       | The unit author's surface: `infra`, `entrypoint`, `unit`, handles, tokens, `rename` and the contract types.                       |
| `@arki/dot/feature`      | `defineFeature`, `unit` (for `fromFeatures`), `routerFor`, `entrypointOnly` and the services bag for domain modules.                        |
| `@arki/dot/orpc`         | `rpc`, `needsMiddleware`, `step`, `around`. Needs the optional peer `@orpc/server`.                    |
| `@arki/dot/log`          | `log()`, the logging unit. Mount it first.                                                                   |
| `@arki/dot/runtime`      | `createAppRuntime`: one started app per server process, safe under Vite hot updates.                           |
| `@arki/dot/test-harness` | `testUnit`, `testApp`, `bootTestApp`, `fake`.                                                                |
| `@arki/dot/action` | Browser-safe `action`, canonical execution failures and exposure policy. |
| `@arki/dot/execute` | Server `bindAction`: `run` validates raw values; `handle` reuses native parsing. |
| `@arki/dot/telemetry` | Identity-scoped `telemetryFor`, spans, events, metrics and correlated logs. |
| `@arki/dot/cli`          | `program` (the `dot` command), `runExplain`, `runDoctor`, `runNew`, `runDev` and the `dot.*` failures.         |

Read [Ownership](./docs/ownership.md) for resource descriptors, children, lazy retries and cancellation.

## Failure behaviour

Every managed phase returns typed `@arki/failure` values. Check `isFailure(builder.configure())` before reading the manifest, and inspect awaited boot, start, stop and dispose outcomes. Concrete callback refusals remain inferred; unknown exceptions become canonical `UnexpectedDefect` values. Static declaration helpers can still throw outside a managed boundary. See [Upgrade typed phases](./docs/upgrade-phases.md) for the breaking changes and exact phase outcomes.

Legacy `ARKI_DOT_E*` IDs remain diagnostic metadata, not top-level failure codes. Kernel-generated defects retain their `DotLifecycleError` (phase, unit and original cause) inside `UnexpectedDefect.cause`. Owned provider/boot task defects retain the original private cause; diagnostics record phase, owner and legacy ID with safe remediation and docs links. Codes are never renumbered or reused (E009 and E010 are retired). `FeatureError` (E022–E031) and `DotManifestError` (E032) can still escape unmanaged static declarations; CLI module loading supervises them.

The legacy rows below describe diagnostic IDs and their private cause classes. Match returned failures by their canonical definition; inspect legacy IDs locally in the private cause or in diagnostics.

| Code                         | Class               | Meaning                                                                                       | Fix                                                    |
| ---------------------------- | ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `dot.action_not_exposed` | Failure value | The adapter is not exposed by the action. | Use a declared binding. |
| `dot.action_principal_required` | Failure value | No authenticated principal attestation. | Authenticate credentials and expiry at the adapter. |
| `dot.action_approval_required` | Failure value | No invocation approval attestation. | Verify caller, action and input approval at the adapter. |
| `dot.preflight_failed`       | Failure value       | Managed preflight failed; `.error.data` contains `app`, `migrations`, `report` and `failure`. | Fix the reported lifecycle failure; exit code is 3.    |
| `dot.lazy_closed`            | Failure value       | A lazy handle is used after its owner closed.                                                 | Obtain a handle from a live owner.                     |
| `dot.runtime_replaced`       | Failure value       | HMR replaced this runtime.                                                                    | Use the current module.                                |
| `dot.runtime_release_failed` | Failure value       | Previous ownership was not safely released.                                                   | Resolve disposal before starting another owner.        |
| `ARKI_DOT_E001`              | `DotLifecycleError` | `configure` returned a Promise.                                                               | Make `configure` synchronous; do async work in `boot`. |
| `ARKI_DOT_E002`              | `DotLifecycleError` | `configure` threw.                                                                            | Fix the unit's config or its `configure` hook.       |
| `ARKI_DOT_E003`              | `DotLifecycleError` | `boot` threw. Booted units were rolled back.                                                | Read `unit` and `cause`; fix that `boot` hook.       |
| `ARKI_DOT_E004`              | `DotLifecycleError` | `start` threw.                                                                                | Read `unit` and `cause`; fix that `start` hook.      |
| `ARKI_DOT_E005`              | `DotLifecycleError` | One or more `stop` hooks threw.                                                               | Read `failures`; each names the unit.                |
| `ARKI_DOT_E006`              | `DotLifecycleError` | One or more `dispose` hooks threw.                                                            | Read `failures`; each names the unit.                |
| `ARKI_DOT_E007`              | `DotLifecycleError` | The app was reused after `dispose()`.                                                         | Build a fresh app instance.                            |
| `ARKI_DOT_E008`              | `DotLifecycleError` | The app was reused after a failed lifecycle.                                                  | Build a fresh app instance.                            |
| `ARKI_DOT_E011`              | `DotLifecycleError` | A unit was registered twice.                                                                | Remove the second mount, or `rename` it.            |
| `ARKI_DOT_E012`              | `DotLifecycleError` | A need no unit provides (erased or JS graphs).                                              | Mount the provider before its consumer.                |
| `ARKI_DOT_E013`              | `DotLifecycleError` | A wire key is provided twice.                                                                 | `rename` one provider.                                 |
| `ARKI_DOT_E014`              | `DotLifecycleError` | A key uses the reserved `$` prefix.                                                           | Rename the key.                                        |
| `ARKI_DOT_E015`              | `DotLifecycleError` | A hook ran past `hookTimeoutMs`.                                                              | Pass `$signal` to the hook's I/O, or raise the budget. |
| `ARKI_DOT_E016`              | `DotLifecycleError` | Two actions in one binding share an id.                                                       | Give each action its own id.                           |
| `ARKI_DOT_E017`              | `DotLifecycleError` | Action `meta` is not plain JSON.                                                              | Keep `meta` JSON-safe.                                 |
| `ARKI_DOT_E018`              | `DotLifecycleError` | More than one logging unit.                                                                 | Keep one `log()`.                                      |
| `ARKI_DOT_E019`              | `DotLifecycleError` | Needs and provides form a ring.                                                               | Move the shared piece into a third unit.               |
| `ARKI_DOT_E020`              | `DotLifecycleError` | A provider is mounted after its consumer.                                                     | Mount the provider first.                              |
| `ARKI_DOT_E021`              | `DotLifecycleError` | `$describeAction` named an action the unit may not amend.                                   | Describe only your own actions.                        |
| `ARKI_DOT_E022`              | `FeatureError`      | Two routers use the same key.                                                                 | Rename one key.                                        |
| `ARKI_DOT_E023`              | `FeatureError`      | Two repos use the same key.                                                                   | Rename one key.                                        |
| `ARKI_DOT_E024`              | `FeatureError`      | Two slices use the same key.                                                                  | Rename one key.                                        |
| `ARKI_DOT_E025`              | `FeatureError`      | A feature has no slices.                                                                      | Add at least one slice.                                |
| `ARKI_DOT_E026`              | `FeatureError`      | A handle is missing from the services bag.                                                    | Mount the provider; check the gateway's needs.         |
| `ARKI_DOT_E027`              | `FeatureError`      | A feature key collides with another slot or a reserved name.                                  | Rename the alias or key.                               |
| `ARKI_DOT_E028`              | `FeatureError`      | `override()` named a key no infra unit provides.                                            | Override a key the feature's infra provides.           |
| `ARKI_DOT_E029`              | `FeatureError`      | `routerFor()`: an app-contract key has zero or several owners.                                | Give each key exactly one feature.                     |
| `ARKI_DOT_E030`              | `FeatureError`      | `routerFor()`: a feature's contract is not mounted in the app contract.                       | Mount it in the app contract.                          |
| `ARKI_DOT_E031`              | `FeatureError`      | `rpc()`: a procedure's contract `meta` is not plain JSON.                                     | Keep contract `meta` JSON-safe.                        |
| `ARKI_DOT_E032`              | `DotManifestError`  | Manifest data is not plain JSON.                                                              | Pass plain JSON only.                                  |
| `ARKI_DOT_E033`              | `DotLifecycleError` | A unit is mounted on the wrong side (an entrypoint in `.infra()`, or an infra or feature unit in `.entrypoints()`). | Mount infra with `.infra(...)`, entrypoints with `.entrypoints(...)`. |

The `dot` command returns `dot.*` failure codes (`dot.app_not_found`, `dot.doctor_failed`, ...) in the `arki.cli/1` envelope; see the [agent guide](./docs/agent-guide.md#errors) and [The `dot` command](./docs/cli.md). Exit codes: `0` ok, `1` bug, `2` usage, `3` a returned failure.

## Limits

- **`configure` is synchronous.** A `configure` that returns a Promise fails
  with `ARKI_DOT_E001`, even when the Promise is already resolved. Do async
  work in `boot` or in a `provides` factory.
- **Declaration order is boot order.** Nothing sorts the units for you.
  `.infra(orders, database)`, where `orders` needs `database`, is a compile
  error. With the types erased (plain JavaScript, or Bun running a file
  without a type check) it is `ARKI_DOT_E020` at `configure`. The
  [Quickstart](./docs/quickstart.md) shows both.
- **One copy of each unit.** `.infra(cache, cache)` is `ARKI_DOT_E011`.
  A second copy needs `rename`.
- **One logging unit per app.** A second one is `ARKI_DOT_E018`.
- **No hook watchdog by default.** A hook that never settles hangs the app
  until you pass `hookTimeoutMs`. With it, the slow hook fails with
  `ARKI_DOT_E015`.
- **`dot doctor` never calls `start`.** Workers and servers that begin in
  `start` are not checked by it. Test them in your app's tests.
- **Lists are checked up to 1024 units.** An `.infra()`, `.features()` or `.entrypoints()` list
  with more entries is a compile error.
- **Manifest data is plain JSON.** Functions, `Date`s, `Map`s and cycles in
  action or contract `meta` fail with `ARKI_DOT_E017`, `ARKI_DOT_E031` or
  `ARKI_DOT_E032`.

## Documentation

Start with [Principles](./docs/principles.md): five rules every API and error
is measured against. Then pick the page for your task. The full index is
[docs/README.md](./docs/README.md).

| Page                                                   | Read it to                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| [Quickstart](./docs/quickstart.md)                     | build an app, break it, and read the error.                         |
| [Dependency injection](./docs/di.md)                   | wire needs and provides, tokens, `rename`, lazy services, features. |
| [A complex setup](./docs/complex-setup.md)             | see a many-unit app and the order it boots in.                    |
| [Testing units](./docs/testing.md)                   | test a unit against fakes, or several units together.           |
| [Logging, shutdown and timeouts](./docs/operations.md) | run an app under a process manager.                                 |
| [The `dot` command](./docs/cli.md)                     | use `dot new`, `dot explain`, `dot doctor` and `dot dev`.           |
| [Unit authoring](./docs/unit-authoring.md)         | write a unit.                                                     |
| [Lifecycle](./docs/lifecycle.md)                       | learn the five hooks and their failure rules.                       |
| [Diagnostics](./docs/diagnostics.md)                   | read `app.manifest` and `app.diagnostics`.                          |
| [Observability](./docs/observability.md)               | export traces and metrics with OpenTelemetry.                       |
| [Adapter authoring](./docs/adapter-authoring.md)       | expose your package as a `./dot` unit.                            |
| [Deploy an app](./docs/recipes/deploy.md)              | ship a generated app in a container.                                |
| [Upgrade typed phases](./docs/upgrade-phases.md)       | handle inferred phase failures and supervised usecases.             |
| [Upgrade Dot](./docs/recipes/upgrade.md)               | move to a new version and check the app still boots.                |
| [Agent guide](./docs/agent-guide.md)                   | let a coding agent inspect and change an app.                       |

Agents start at [`llms.txt`](./llms.txt).

<!-- bench:start -->

## Benchmarks

A 20-service graph where each service depends on the two before it, built with `@arki/dot` units and with awilix, the most used dependency-injection container for Node. A hand-wired version is the floor: no container at all.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Build the graph and bring it up (boot + dispose, 20 services)

dot: declare 20 units, boot, dispose. awilix: create a container, register 20 factories, resolve all 20, dispose. Hand-wired: build the 20 objects in order.

| Library                               | Time / op | vs fastest |
| ------------------------------------- | --------: | ---------: |
| @arki/dot (boot + dispose)            | 199.83 µs |     14.99× |
| awilix (register + resolve + dispose) |  65.92 µs |      4.94× |
| hand-written wiring (no container)    |  13.33 µs |    fastest |

### Look up a service after boot

The hot path: code that already has a booted app asks for one service. dot services are plain properties; awilix `resolve` and `cradle` go through a cache lookup.

| Library                              | Time / op | vs fastest |
| ------------------------------------ | --------: | ---------: |
| @arki/dot (app.services.s19)         |   30.3 ns |    fastest |
| awilix (container.resolve('s19'))    |   67.2 ns |      2.21× |
| awilix (container.cradle.s19)        |  105.4 ns |      3.47× |
| hand-written (plain object property) |   32.0 ns |      1.05× |

Read the rows with the contracts in mind:

- `@arki/dot` and awilix do different jobs. awilix is a container: it registers factories and builds them on first use. dot runs an application lifecycle: it orders units by their declared needs, runs `configure`, `boot` and `dispose` hooks in order (and in reverse on shutdown), checks the wiring at compile time, and records a manifest and diagnostics for every unit.
- The boot rows therefore measure more work in dot than in awilix. They are shown so you can see what that lifecycle costs, not to say the two are interchangeable.
- Boot is async in dot (unit hooks may await). awilix resolves synchronously.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## Support

Report bugs and ask questions at
[github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).
Include the output of `dot doctor --json` and the `code` of the error you saw.
Changes are listed in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT — see [LICENSE](./LICENSE).

Read [Action boundaries](./docs/actions.md) and [Upgrade action boundaries](./docs/upgrade-actions.md).
