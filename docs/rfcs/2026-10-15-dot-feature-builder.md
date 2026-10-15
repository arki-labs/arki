# RFC: Dot feature builder — `defineFeature`, layers, contract-first

- **Status**: Accepted (2026-10-15). Phase 1a (Dot core) implemented in `packages/dot` (`src/define-feature.ts`, `src/define-app.ts`); adapters, template and apps follow in phases 1b–5 of `.work/plans/2026-10-15-dot-feature-builder.md`.
- **Authors**: Fable (design), Astra (review), founder (decisions).
- **Sources**: the design files below, copied verbatim from the session scratchpad so they outlive it. Paths inside them that point to the scratchpad or `/private/tmp` are historical.

## Founder decisions (2026-10-15)

1. **Layers = folders = builder steps**, one name each: `model/` (zod schemas, drizzle tables, ids, pure rules, journal events and entities; no builder step), `usecases/` (`.usecases(...)`), `infra/` (`.infra(...)`: the feature's own store, outside clients, journal projections — all Dot plugins), `entrypoints/` (`.entrypoints(...)`: oRPC contract + procedures, schedules, HTTP routes, journal effects and taps). Plus `feature.ts`.
2. **Feature chain**: `defineFeature(name).needs({...}).infra(...).usecases(...).provides({...}).entrypoints(...)`. **App chain**: `defineApp(name).infra(...).features(...).entrypoints(...)`. `.use()` folds into `.infra()` (log, observability and action infrastructure are what the app runs on; argument order is boot order, log first); `.serve()` becomes `.entrypoints()`.
3. **Lean rules**: no port/interface file by default — the adapter's inferred type is the port (`Provided<typeof store.provides.store>`; `usecases/` may `import type` from `infra/`); a separate interface only when it pays; a folder exists only when non-empty.
4. **oRPC contract-first is mandatory and enforced**: browser-safe `entrypoints/contract.ts`, `implement(contract)` with needs bound, `routerFor(appContract, features)` writes mount keys once, exemptions listed, request context = `session` / `headers` / `services`.
5. **Journal** (accepted picks): one structure; entities in `model/`; projections in `infra/` via `journalProjections(...)`; effects and taps in `entrypoints/` via `journalEffects(...)`; both adapter-owned descriptors in `@arki/journal/dot`, normalized into one internal slice; commands in `usecases/`; contract and command share the input schema; actor-bound `context.run` via a helper with an app-supplied actor selector; `dot explain` event → effect edges. App: `.infra(..., journal({ j, tables }))` and `.entrypoints(..., journalWorker())`.
6. **Every type written once**, inferred end to end; no `any`; only commented erasure seams; import purity; `dot explain` sees every edge; capability handles for cross-feature deps; existing Dot guarantees kept (E019/E020, static provides, `fake(handle, value)`).
7. **Astra's three review changes adopted**: no `core.ts` (the chain stays in `feature.ts`; entrypoint files take `core` / `os` as `import type` parameters); the compilation invariants fixed (sibling-need remap, atomic override, reserved names, typed plugin tuple); migration re-scoped over every adapter and both apps.
8. **One breaking release**: the new API lives next to the old one inside the monorepo during the migration series; the last phase deletes the old API; the founder then releases (Stage 2).

## Contents

- Part A — `defineFeature` / `defineApp` final design (Fable, Revision 2 on top).
- Part B — Context vs `needs`, contract-first (Fable, Revision 1 on top).
- Part C — Hexagonal layering (Fable).
- Part D — `@arki/journal` inside the layered feature (Fable, then Astra's review).

---

# Part A

# `defineFeature` / `defineApp` — final design (Fable, 2026-10-15)

Probe: `scratchpad/avocabo-dot/probe/builder/` — `tsc -p tsconfig.builder.json` exit 0 with every `@ts-expect-error` honoured; `node out/builder/main.js` boots the real kernel (`testApp` = `defineApp`) twice (drizzle store, then an overridden fake), calls the procedure through `routerFor` + `implement(appContract)`, runs a schedule handler, prints the units `dot explain` sees, and gets `DOT_LIFECYCLE_E020` when the feature is mounted before its own store. `builder/lib/define-feature.ts` is the prototype of the `@arki/dot` code.

## Revision 2 — Astra's three changes folded in (supersedes § a, b, d, e, f below)

Verified Astra's probe myself (`/private/tmp/astra-fable-builder-review/builder`: `tsc` exit 0, same runtime output, emitted `procedures.js` has no back-import). All three changes adopted; each invariant below has a probe check that failed on the Revision 1 prototype and passes now (`probe/builder/`: `tsc -p tsconfig.builder.json` exit 0 with every `@ts-expect-error` honoured; `node out/builder/main.js` prints 17 `ok` lines).

### R2.1 No `core.ts` — the chain stays in `feature.ts`

Astra is right: the module graph forbids an *eager* back-import, not a type reference. Entrypoint files export factories typed by `import type` of the intermediate values, and `feature.ts` calls them:

```ts
// features/daily-digest/feature.ts — the whole chain, one file
export const core = defineFeature('daily-digest').needs({ plans: billing.provides.entitlements }).infra(store, mailer).usecases(createUsecases);
export const os = implement(digestContract).$context<RequestContext>().use(bind(core));
export const dailyDigest = core
  .provides({ digests: ({ usecases }) => ({ previewFor: usecases.preview }) })
  .entrypoints(rpc(digestContract, procedures(os)), digestSchedules(core), journalEffects(core, { effects: [distill] }));

// entrypoints/procedures.ts — a factory over the implementer; `import type` only
import type { os } from '../feature';
export const procedures = (o: typeof os) => ({ preview: o.preview.use(authed).handler(({ context }) => context.usecases.preview(context.session.user.id)) });

// entrypoints/schedules.ts
import type { core } from '../feature';
export const digestSchedules = (c: typeof core) => schedules(c, [{ name: 'send-digest', cron: '*/15 * * * *', handler: ({ usecases }) => usecases.sendDue() }]);
```

`typeof os` depends on `core` (needs, infra, usecases), never on `dailyDigest`, so there is no TS7022; `import type` is erased, so there is no TDZ. Browser check: `tsc --listFilesOnly` for `entrypoints/contract.ts` loads only `model/schemas.ts` and the contract — `typeof os` is never on the browser's path. Per-feature files: `model/`, `usecases/`, `infra/`, `entrypoints/{contract,procedures,schedules}.ts`, `feature.ts`. Nothing else.

### R2.2 Compilation invariants (each proved)

| Invariant | Before (R1 prototype) | Now | Probe |
| --- | --- | --- | --- |
| Override of a multi-service plugin keeps siblings | first matching key became a `fake`, siblings dropped | the plugin is rebuilt atomically: same name, same needs, overridden keys → value, other keys → the original factory | `store` faked, `digest.stats.count()` still 5 |
| Qualified private keys remap sibling needs | `mailer.needs.store` kept wire key `store` → `DOT_LIFECYCLE_E012` | needs whose witness names a sibling's local key are rewritten to `<feature>.<key>` (value and type: `Qualified<TName, P, Pre>`) | effect runs through mailer → store: `mailed d_2`; manifest shows `digest/mailer` requires `digest.store` |
| Reserved aliases / collisions are compile errors | silently overwrote context or factories | `needs<N extends NeedsShape & NoKeys<'session'|'headers'|'services'|'usecases'>>`; `infra(...plugins: I & InfraGuard<N, I>)` rejects an infra key equal to a need alias or reserved; `provides<P extends … & NoKeys<Reserved>>`; `entrypoints(...e: E & EntrypointGuard<P, E>)` rejects an entrypoint key equal to a provided key or `usecases`; runtime `checkCollisions` for erased callers | 7 `@ts-expect-error` cases in `types-check.ts` |
| Flattened plugin list keeps its tuple type | `readonly AnyPlugin[]` → `UseAllGuard` demanded an error arg | `plugins(): readonly [...QualifiedAll<TName, I>, FeaturePlugin<…>]` with exact needs/provides types | `defineApp().use(database).use(billing).useAll(digest.plugins())` typechecks; `.use(digest.plugins()[2])` before its infra is a compile error |
| Finished-feature `override` preserves entrypoints | returned a stage | `Feature.override(values): Feature<…same E…>` | `Eq<ReturnType<override>, typeof digest>` true; faked boot runs procedure, schedule and effect |
| `dot explain` edges asserted | printed keys only | assertions on `app.manifest.plugins[].dependencies`: feature → `digest.store` + `entitlements`, store → `db`, mailer → `digest.store` | 3 `ok` lines |
| Journal metadata before boot | — | the journal descriptor carries static `handlers` and actions with `meta.events`; readable from `feature.plugins()[n].actions` before any boot and present in `app.manifest.actions` | 2 `ok` lines (`DigestRequested`, `send-on-request.run`) |
| Kernel order | — | feature mounted before its own infra → `DOT_LIFECYCLE_E020`; infra absent → `E012` | 2 `ok` lines |

Entrypoint payloads are published as one record under `feature.<name>` (exactly what `plug()` does today), so adapters that read `sliceOf(ctx, f)[key]` — `@arki/queue` (`dot.ts:231`), `@arki/schedule`, `@arki/journal` — keep their boot-time read; their pre-boot read moves from `f.use` to `f.entrypoints` (same static list, `key` unchanged: `'queue'`, `'schedules'`, `'journal'`). Journal projections declared as infra plugins expose the same static `handlers` field, read from `f.plugins()`.

### R2.3 Cost, itemised (one implementer, days)

| Item | Days |
| --- | --- |
| `@arki/dot`: `defineFeature` stages + guards + typed tuple compile, `routerFor`, `servicesOf` over plugins, `.infra`/`.entrypoints` renames, `features()` flattening, `use`/`useAll`/`serve`/`feature()`/`plug`/`composeRouter`/`composeRepos` removed, `AnyFeature` → `{ name, entrypoints, plugins }`, `dot doctor` codes | 4.0 |
| `@arki/dot` tests (26 files touched where they build features/apps; ~8 new: stages, guards, override, remap, tuple, explain edges) | 1.5 |
| `@arki/dot/orpc`: `needsMiddleware`, `rpc()`, type tests | 0.5 |
| `@arki/schedule/dot`: `schedules(core, defs)`, read `f.entrypoints`, tests | 0.5 |
| `@arki/journal/dot`: `journalProjections` (infra plugin with static handlers), `journalEffects` (entrypoint), collector reading `f.entrypoints` + `f.plugins()` before boot, `actorRun` helper in `/orpc` with app actor selector, event→effect meta, tests | 1.5 |
| `@arki/queue/dot`: `declaredRegistry` over `f.entrypoints`, tests | 0.5 |
| `@arki/http/dot`: `endpoints(core, build)`, read `f.entrypoints`, tests | 0.5 |
| Docs: Dot README/llms/composition-doctrine, each adapter's README + llms (5 packages), changesets | 1.0 |
| Template: app chain, example feature (four folders, `oc.route`, schedule, journal effect), `contract.ts` export, ESLint `feature-layers`, two vitest guards | 1.0 |
| Avocabo: app core (`core/orpc.ts`, `contract.ts`, `root.ts`, `gateway.ts`, `app.server.ts`, `routes/api` mounts + exemptions) | 1.0 |
| Avocabo: 21 features + gateway unit — contract-first (schemas), four folders, chain, cron routes (dominant cost; same in object form) | 10.0 |
| Novelette: backend 20 features + server 3 on `@arki/http` descriptors (`endpoints(core, …)`); queue adapter | 4.0 |
| kapodopera 2, lottomato 2, brandability 1 | 1.0 |
| Verification: `turbo typecheck`, prod `vite build` leak check, e2e runs, `dot explain` snapshots per app | 1.5 |
| **Total** | **28.5** |

Feature-declaring units in the monorepo: 51 (`feature(` call sites: Avocabo 23 incl. gateway, Novelette 20 + 3, kapodopera 2, lottomato 2, brandability 1) — Revision 1 said 49. The chain premium over the object form is still ~1.5 days, all inside the first row; everything else is identical. 28.5 days is about six working weeks for one implementer — the honest number; the earlier 21 undercounted queue, journal collection, tests, docs and verification.

### R2.4 One breaking release, no dual API

Pre-1.0: breaking = minor changeset, no aliases. The migration is one series of commits on master that is **not released** until the last one: Dot + adapters + template first (typecheck of apps goes red at commit 1 and is restored app by app), then Avocabo, Novelette, the three small apps, then the commit that deletes the old exports and adds the changesets. Release the five packages together after that commit. The repo is "internally inconsistent" for the series, which is normal for a monorepo on master; nothing ships with two feature APIs.

### R2.5 What `.use()` becomes

Folded into `.infra()` (Astra agrees): log, observability and action infrastructure are what the app runs on; argument order is boot order, so `.infra(log(...), database, …)` keeps log first.

### Open risks (updated)

- `Qualified<…>` types are proved for one level of infra; an infra plugin that was itself `rename`d before being handed to `.infra()` reads its local keys through `renames` in `replaceServices` but the type-level remap assumes unrenamed inputs.
- The journal descriptor's static `handlers` must be type-checked by the collector (`readDeclarations` already validates shape at boot; it now runs before boot).
- A feature-private infra plugin providing a key that another feature's `needs` alias uses is fine (keys are qualified); a *public* `provides` key equal to another feature's public key is still the existing E0xx duplicate-provider error at boot, not a compile error across features.
- 28.5 days with one breaking release means ~6 weeks of a red workspace typecheck between commit 1 and the end of the series unless the Dot commit lands with the Avocabo core in the same day; sequencing Dot + template + Avocabo core as the first three commits keeps the red window to Avocabo's feature folders only.

---

## The API

```ts
// features/daily-digest/core.ts — what the feature needs, connects to and does. No entrypoint imports this file's importers.
export const core = defineFeature('daily-digest')
  .needs({ plans: billing.provides.entitlements, journal: journal.provides.journal })
  .infra(store, mailer, journalProjections(digestStats))
  .usecases(createUsecases);                         // (deps: { store, mailer, plans }) => ({ compileDigest, sendDue, … })
export const os = implement(digestContract).$context<RequestContext>().use(bind(core));

// features/daily-digest/feature.ts — the feature: core + what it offers + how it is reached.
export const dailyDigest = core
  .provides({ digests: ({ usecases }) => ({ previewFor: usecases.preview }) })
  .entrypoints(rpc(digestContract, procedures), digestSchedules, journalEffects(core, { effects: [distill] }));

// backend/src/app.ts
export const app = defineApp('avocabo')
  .infra(log(...), database, cache, authn, journal({ j, tables }))
  .features(features)
  .entrypoints(gateway, schedule({ clock: 'host' }), journalWorker());
```

Folder = step: `model/` (no step), `infra/` ↔ `.infra()`, `usecases/` ↔ `.usecases()`, `entrypoints/` ↔ `.entrypoints()`; `core.ts` holds the chain up to `.usecases()`, `feature.ts` finishes it. A CRUD feature has no `usecases/` and no `.usecases()` step; its handlers call `context.store` (the private infra handle is on the context too).

## a. Type machinery and the import graph

**Stages.** `defineFeature(name)` returns a `NeedsStage`; each stage type only offers later steps (`NeedsStage → InfraStage → UsecasesStage → ProvidesStage → EntrypointsStage → Feature`), so `.infra(a).needs({})`, `.infra(a).infra(b)` and `.provides({}).usecases(…)` are compile errors (probe `types-check.ts`). One runtime object serves every stage (one commented seam); the final `Feature` is a different object, because `provides` is a method on the stage and a handle record on the feature.

**What each step receives.** `Deps = CtxOf<needs> & InfraProvides<infra>` where `InfraProvides` merges `PluginProvides` of the infra plugins — `.usecases((deps) => …)` is checked against it (a usecase asking for `mailer` when no infra provides it is a compile error). `Full = Deps & { usecases: U }` is what `.provides` factories and every entrypoint receive. `usecases/index.ts` declares what it needs (`{ store: Store; plans: Plans }` with `Store = Provided<typeof store.provides.store>`, the one type-only import from `infra/`); the core checks it supplies that — types written once, in the usecase.

**Private handles.** `.infra(store)` compiles to `rename(store, { store: 'daily-digest.store' }, 'daily-digest/store')`; the feature's own needs gain `store: <that handle>` under the local alias. Probe output: `unit digest/store | needs: db | provides: digest.store`, `unit digest | needs: entitlements, digest.store`. Only declared needs propagate: another feature cannot name `digest.store` because no exported handle carries that key; it names `dailyDigest.provides.digests`.

**Usecases as a capability.** The usecases object is published under `daily-digest.usecases` (local key `usecases`, renamed on the wire). A kernel factory sees the plugin's needs, not its sibling provides (`kernel/app-instance.ts:1138`: `factory(ctx)` with the needs ctx; `boot` gets `{ ...ctx, ...published }`), so the builder creates the object once per boot and hands it to every provides factory and entrypoint (`WeakMap` on the boot ctx). The request path resolves it through the bind middleware.

**`core.handles`** = `needs & { [infra key]: Handle } & { usecases: Handle<U> }`, every entry a typed `Handle`. `bind(core)` (app `core/orpc.ts`, built on `@arki/dot/orpc`'s `needsMiddleware`) resolves them from the request's `services` bag; `Provided<typeof core.handles.usecases>` equals `ReturnType<typeof createUsecases>` (probe `usecasesTyped`). The handler sees `context.usecases`, `context.store`, `context.plans`; `context.db` is a compile error (it is the store's need, not the feature's).

**Why `core.ts` exists (proved).** `entrypoints/procedures.ts` needs `os`, whose type carries the needs + infra + usecases types; `feature.ts` needs `procedures` for `.entrypoints(rpc(...))`. If `os` lived in `feature.ts`, `feature.ts → procedures.ts → feature.ts` is an ESM cycle (earlier probe: `ReferenceError: Cannot access 'os' before initialization`) and a TS7022 type cycle. The chain is therefore split at the stage boundary the module graph demands: `core.ts` (needs/infra/usecases + `os`), `feature.ts` (provides/entrypoints). Graph, no cycle: `feature.ts → core.ts, entrypoints/*`; `entrypoints/* → core.ts`; `core.ts → infra/, usecases/, entrypoints/contract.ts, <other>/feature.ts`; `usecases/ → model/, type-only infra/`. Procedures import no usecase file; they use `context.usecases`. `entrypoints/schedules.ts` is `schedules(core, defs)`: handlers typed by the core's phantom deps type (`DepsOf<typeof core>`), so a separate file infers without annotations — the same reason today's `schedules(needs, defs)` takes `needs` (`packages/schedule/src/dot.ts:209`).

**Contract.** `entrypoints/contract.ts` imports only `model/schemas.ts`; `rpc(contract, procedures)` requires `procedures: Router<typeof contract, never>` (bare `os` router and wrong contract rejected, probe). `Feature.contract` / `Feature.router` are extracted from the `rpc` descriptor's type, so `routerFor(appContract, features)` and `implement(appContract).router(...)` from Revision 1 work unchanged (probe `main.ts`). No barrel in `entrypoints/`; the browser imports `entrypoints/contract.ts` by path.

## b. Compiling into today's kernel; what changes and what goes

`Plugin`, the manifest, lifecycle, rings, `rename`, `fake`, `sliceOf`: unchanged. `Feature.plugins()` returns `[...qualified infra plugins, featurePlugin]` where the feature plugin is `plugin({ name, needs: needs + infra handles, actions: entrypoint actions, provides: { usecases, ...provides, [entrypoint.key]: resolve } })` with `renames` for `usecases` and each entrypoint key, `role: 'feature'`. This is `plug()` plus the infra flattening; `plug()` is replaced by it.

| File | Change |
| --- | --- |
| `feature.ts` → `define-feature.ts` | new stage types, `Feature`, `plugins()`, `Entrypoint`, `DepsOf`, `routerFor`; `servicesOf` over `HasProvides[]`; `feature()` object form, `composeRouter`, `composeRepos`, the `repos`/`router` slots and `RouterFragments` removed |
| `define-app.ts` | `.use()` → `.infra(...plugins)` (variadic; also replaces `useAll`), `.serve()` → `.entrypoints(...adapters)` (variadic); `.features()` flattens `f.plugins()` and keeps the `UseAllGuard` on the flattened list (E019/E020 stay kernel checks) |
| `plugin-contract.ts` | no change; `AnyHandle`/`handleOf` exported from `@arki/dot/plugin` (the prototype had to mint handles through `rename`) |
| `@arki/dot/orpc` (new) | `needsMiddleware<Ctx>()`, `rpc()`; the one `IntersectPick` seam lives here with its type test |
| `test-harness.ts` | `testApp` unchanged; `fake` unchanged |

`.use()` for non-adapter plugins (log, observability, action catalogs) is folded into `.infra()`: they are infrastructure the app runs on, they are mounted first today (`.use(log(...))` must be first, AGENTS.md), and decision 1 wants one name per slot. `.infra(log(...), database, cache, authn)` keeps their order by argument order. Pre-1.0: `use`, `useAll`, `serve`, `feature()`, `plug`, `composeRouter`, `composeRepos` are deleted at the end of the migration series (see f), not aliased.

## App `.infra` vs feature `.infra` (founder addition)

Same word, same kind, different scope — the scope is already in the name and the key, so a second word would say less:

| | app `.infra(...)` | feature `.infra(...)` |
| --- | --- | --- |
| who sees it | every feature, by the plugin's handle (`database.provides.db`) | only this feature's usecases, factories and entrypoints, by alias (`store`) |
| wire key | the plugin's key (`db`); one per key, `rename` for a second | `daily-digest.store`; two features may each have `store` |
| unit name | `database` | `daily-digest/store` (nested under the feature in `dot explain`) |
| boot | first; owns process resources (pool, Redis, auth) | after the app infra it needs, before its feature (kernel order, E020 proved) |
| reachable by others | yes | only through the feature's `.provides` |

Needs propagate without copying: the infra plugin is its own kernel unit with its own needs (`store` needs `database.provides.db`); the feature needs the infra handle; the kernel orders transitively and `dot explain` draws `daily-digest → daily-digest/store → database` (probe output). May a feature's infra own a process resource? It can — a plugin has `start/stop/dispose` and the kernel disposes in reverse order — and it should when the resource is feature-local (an RSS fetcher's HTTP client with its own rate limiter, an LLM client with a feature-level budget). It must not open a second Postgres pool or Redis client: connection budgets and transactions are app-level, so a feature store needs the app's `db`. Rule: feature infra wraps the app's shared handles or owns a client nobody else would share; `dot doctor` flags a feature-private plugin that needs a URL/env secret directly.

## c. Entrypoint descriptors — the protocol adapter packages implement

```ts
type Entrypoint<TServices> = { kind: string; key: string; actions: readonly ActionSource[]; resolve: (services: TServices) => unknown };
```

Today's `FeatureSlice` plus `kind` — structural, so `@arki/schedule`, `@arki/journal`, `@arki/http` import nothing from Dot at runtime (today's rule, `feature.ts:60-66`). `resolve` runs at the feature's boot with `Full` (needs + infra + usecases) and its payload is published under `<feature>.<key>`; the app-level entrypoint adapter (`schedule(...)`, `journalWorker()`, `http(...)`) reads it with `sliceOf`, as now. Typing: a descriptor built in its own file takes the core — `schedules(core, defs)`, `journalEffects(core, { effects })`, `endpoints(core, build)` — and types its handlers with `DepsOf<typeof core>` (exported type). `rpc(contract, procedures)` is the one descriptor with static data (`contract`, `router`); `kind: 'rpc'` lets `Feature` extract them. Journal: `journalProjections(...)` is an infra plugin (inline lane, same transaction), `journalEffects(core, …)` an entrypoint; `@arki/journal/dot` normalizes both into its one internal slice; Dot stays journal-agnostic.

## d. Testing — swapping infra before compilation

`core.override({ store: fakeStore })` replaces the matching infra plugin with `fake(handle, value)` **inside the feature's list**, so `plugins()` yields exactly one provider for `daily-digest.store` (probe: `fake units: digest/store, digest`, then `fake store -> { id: 'fake' … }`). Mounting a `fake` next to the real plugin would be the duplicate Astra warned about; the override is the only door, and its argument is typed by the port (`override({ store: { nope: 1 } })` is a compile error). In the shipped version `override` also exists on the finished `Feature` and returns a `Feature` (same provides and entrypoints); the prototype's returns the stage. Cross-feature fakes stay `fake(billing.provides.entitlements, value)` in `.infra()` of the test app.

## e. Honest cost — chain vs object form

Both forms need the same things: the folder move, contract-first, `core.ts`/`feature.ts` split (the import graph forces it for the object form too), `plugins()` compile, qualified private infra, usecases capability, descriptors, `override`, kernel renames. The object form `feature(name, { needs, infra, usecases, provides, entrypoints })` infers across properties the way `feature()` does today (`provides` typed from `needs`), so its type work is one generic function instead of five stage interfaces.

| Work | chain | object |
| --- | --- | --- |
| `@arki/dot` core (define-feature, compile, define-app renames, routerFor, servicesOf, tests ~10 files, docs, changeset) | 4 d | 2.5 d |
| `@arki/dot/orpc` (needsMiddleware, rpc, type tests) | 0.5 d | 0.5 d |
| `@arki/schedule/dot`, `@arki/journal/dot` (projections/effects + collector), `@arki/http/dot` | 2 d | 2 d |
| template | 0.5 d | 0.5 d |
| apps: 49 features (Avocabo 21+2, Novelette 20+3, kapodopera 2, lottomato 2, brandability 1), 21 `schedules(` files, 4 app chains — dominated by contract-first + folders, identical in both | ~14 d | ~14 d |
| **total** | **~21 d** | **~19.5 d** |

The chain costs about 1.5 days more, all in Dot, and nothing in the apps. What it buys: the feature reads like the app (`defineApp` is already a chain), stage order is a type error instead of a convention, and each step names its folder. What it costs beyond the days: five stage interfaces to maintain (a new slot = a new stage), and a misplaced step reports "property does not exist on type UsecasesStage" rather than a named error. Verdict: worth it at 1.5 days; it is not over-engineering because the runtime, files and app migration are identical. If the founder prefers the object form, nothing else in this design changes.

## f. Migration order (what lands per commit)

Pre-1.0 means no aliases, but 49 features cannot move in one commit, so the old surface stays for the length of the series and is deleted in the last commit — a window, not an alias.

1. `@arki/dot`: `defineFeature`, `Entrypoint`, `routerFor`, `.infra`/`.entrypoints`, `servicesOf` over plugins, `@arki/dot/orpc`; old `feature()/plug/use/serve` still exported; tests, README, llms, changeset (minor).
2. `@arki/schedule/dot`: `schedules(core, defs)` (keeps `schedules(needs, defs)` for the window).
3. `@arki/journal/dot`: `journalProjections`, `journalEffects`, `actorRun` helper in `/orpc`, event→effect meta; `journalHandlers` kept for the window.
4. `@arki/http/dot`: `endpoints(core, build)`.
5. Template: app chain, example feature (four folders, `core.ts`, one `oc.route` procedure, one schedule), `contract.ts` export, ESLint `feature-layers`, the two vitest guards.
6. Avocabo app: `core/orpc.ts` (RequestContext, bind, authed, admin, cronSecret), `contract.ts`, `root.ts`, `gateway.ts`, `app.server.ts` chain, `routes/api/{orpc.$,api.$}.ts` + `exemptions.ts`; `health` and `waitlist` converted end to end (contract-first + folders + chain).
7–10. Avocabo features in four batches of ~5 by traffic, one commit per feature (folders, contract, core/feature split, cron routes of that feature); `features.ts` and `contract.ts` updated per feature.
11. Novelette backend + server on `@arki/http` descriptors; lottomato, kapodopera, brandability.
12. Delete `feature()`, `plug`, `use`, `useAll`, `serve`, `composeRouter`, `composeRepos`, `schedules(needs, …)`, `journalHandlers`; changeset (minor).

## Open risks

- The stage types rely on `PluginProvides` inference over a `const` tuple of plugins and on `rename`'s typed result; both proved in the probe for one level, not for plugins that are themselves `rename`d.
- Factories do not see sibling provides; the once-per-boot memo is the fix, and `boot`-time consumers of `usecases` must read it from the memo too (the prototype covers factories and entrypoints).
- `override` on the finished `Feature` must preserve the entrypoints' resolved types — one more generic parameter to carry.
- The migration window keeps two feature APIs alive for ~3 weeks; `dot doctor` should warn on `feature()` use from commit 1.

---

# Part B

# Context vs `needs` — design (Fable, 2026-10-15)

## Revision 1 — contract-first is mandatory; enforced (supersedes §2, §5, §8 below)

Founder decisions folded in: contract-first is the default and now mandatory for every oRPC procedure and every HTTP route a Dot feature exposes; an output schema in a contract is the type written once (the handler is checked against it); "import a procedure from needs" was wrong naming; mount keys may be written only once; fewer files per feature. Probe: `scratchpad/avocabo-dot/probe/` — `tsc -p tsconfig.json` exit 0 (with every `@ts-expect-error` below honoured), `node out/src/main.js` runs, `tsconfig.client.json --listFilesOnly` proves browser isolation, `node out/cycle/main.js` proves the cycle.

### R1.1 Decision

Every feature is contract-first. The contract is browser-safe. The implementer is the feature's contract with the feature's `needs` on every handler context. The request context carries request data only. `needs` is the single record for boot, factories, schedules AND handlers, so the kernel and `dot explain` see handler dependencies (probe: `plug(reader).needs` → `['db', 'entitlements']`). A feature's router is accepted only if it implements the feature's contract (type-level), mount keys are written once in the app contract, and the app router is resolved from the app contract by contract identity.

### R1.2 Files per feature (final)

```
features/podcast-support/
  contract.ts       what the feature promises       browser-safe: @orpc/contract + zod (+ ./schemas.ts) only
  implementer.ts    what it needs + its implementer  server: `needs` record and `os = implement(contract).$context<RequestContext>().use(bind(needs))`
  procedures/*.ts   os.<name>.use(authed).handler    server
  feature.ts        feature(name, { contract, router: os.router({...}), needs, provides, boot, use })
```

Four files plus procedures. `router.ts` is gone (`os.router({...})` sits in `feature.ts`; a feature with many procedures may keep a `router.ts` that imports procedures + implementer — it adds no edge). `needs.ts` is gone: `implementer.ts` is the feature's server-side entry, "what this feature needs and how it implements its contract", so `feature.ts` does `import { needs, os } from './implementer'`.

```ts
// implementer.ts
export const needs = { db: database.provides.db };
export const os = implement(podcastsContract).$context<RequestContext>().use(bind(needs));

// procedures/process-episode.ts
export const processEpisode = os.processEpisode.use(authed).handler(async ({ context, input }) => {
  const repo = createPodcastSupportRepository(context.db);   // Db — because implementer.ts declared it
  …
});

// feature.ts
export const podcastSupport = feature('podcast-support', {
  contract: podcastsContract,
  router: os.router({ processEpisode, … }),   // must implement `contract` — compile error otherwise
  needs,
  use: [schedules(needs, …)],
});
```

Import graph (no file reaches its own `feature.ts`; `implementer.ts` never imports procedures or `feature.ts`):

```
feature.ts ──► implementer.ts ──► contract.ts ──► @orpc/contract, zod
    │               │  └────────► db.ts / kv.ts / <other feature>/feature.ts
    │               └───────────► core/orpc.ts (RequestContext, bind, authed, admin)
    └──────► procedures/*.ts ──► implementer.ts
```

Why the implementer must not live in `feature.ts`: probe `cycle/` puts `os` there and dies at import with `ReferenceError: Cannot access 'os' before initialization` (`feature.ts → procedures → feature.ts`). Why no `implementer(contract, needs)` helper: oRPC's `Implementer<C>` is a conditional type, so `.use` is an uncallable union while `C` is generic (probe hit TS2349) — the line is written per feature, which is also the plain oRPC idiom. `authed`/`admin` are per-procedure (`os.x.use(authed)`), typed against `RequestContext`, applied after `bind` on a concrete context (probe: `session` narrows, `context.db` typed).

### R1.3 Enforcement, type level (what changes in `@arki/dot`)

`@arki/dot/feature` (type-only peer deps on `@orpc/contract` + `@orpc/server`; zero runtime):

1. `feature(name, { contract?: TContract, router?: TRouter, … })` with `TContract extends AnyContractRouter = never` and `TRouter extends Router<TContract, never>`. Without `contract`, `Router<never, never>` is `never`, so **any router fails to compile**. With it, the router must implement the contract: same procedures, same schemas. `never` as the initial-context argument is the contravariant bottom (same trick as `(database: never)`): any app context is accepted, `Context` is not (probe tried it; fails).
2. `routerFor(appContract, features)` replaces `composeRouter`. For each app-contract key it takes the router of the one feature whose `contract` is that object (identity at runtime, `Extract<F[number], { contract: A[K] }>` at the type level). Two compile errors at the call: a feature whose contract is not in the app contract; an app-contract key no feature implements (a `never` router would slip through `implement().router`, so the check sits on the parameters). Runtime throws on 0 or 2 owners.
3. `root.ts`: `appRouter = implement(appContract).$context<RequestContext>().router(routerFor(appContract, features))` — second, independent check that the whole composed router implements the app contract.

Probe (`src/core/contract-feature.ts` prototype + `src/enforcement-check.ts`, all `@ts-expect-error` honoured): bare `os` router rejected; missing procedure rejected; router under the wrong contract rejected; feature not in app contract rejected; app-contract key without feature rejected; the real composition typechecks.

`composeRouter` stays only for the migration window (legacy, router-first features) and is deleted when the last feature converts. Runtime belt: `dot doctor` gains `FEATURE_E0xx` "feature has a router but no contract" and "app contract key has no feature" for code that skipped the types.

### R1.4 Composition and what the clients import

- `backend/src/contract.ts` (browser-safe, exposed as `@avocabo/backend/contract`): `export const appContract = { podcasts: podcastsContract, digest: digestContract, … }`. **The only place mount keys are written.**
- `backend/src/root.ts`: `implement(appContract).$context<RequestContext>().router(routerFor(appContract, features))`.
- Browser (`start/src/lib/orpc/raw-client.ts`): `import type { appContract } from '@avocabo/backend/contract'` → `createORPCClient<ContractRouterClient<typeof appContract, AvocaboRpcContext>>(link)` → `createTanstackQueryUtils(rpcClient)` unchanged; the ~87 `orpc.x.y.queryOptions(...)` call sites unchanged (same paths, same types).
- SSR in-process: `gateway.rpc.client(headers)` = `createRouterClient(appRouter, …)` unchanged. Probe: `ContractRouterClient<typeof appContract>` and `RouterClient<AppRouter>` are the same type.
- Extension: the same `ContractRouterClient<typeof appContract>` replaces `rpc<TOutput>(path, input)`; wire paths unchanged.

Browser isolation, measured: a module importing only `./contract` loads `features/*/contract.ts`, `contract.ts`, itself — `packages/dot`: 0 files, `@orpc/server`: 0 files; emitted JS imports only `@orpc/client`.

### R1.5 Output schemas: derive where possible, verify always

- `drizzle-zod` is not in the monorepo and must not enter `contract.ts` anyway: it imports the tables, which import `drizzle-orm` runtime — the leak this design removes.
- 151 zod schemas already exist in 15 `validation.ts` files, none importing drizzle: most inputs are browser-safe today; move them to `features/<f>/schemas.ts` (imported by `contract.ts`).
- Outputs: ~36 procedures return raw repository rows — one zod entity schema each (shared by list/get/update), pinned to the table by a server-side type test `Eq<z.infer<typeof episodeSchema>, typeof episodes.$inferSelect>`: the schema is the type written once, drizzle is checked against it. The rest return computed shapes, written down for the first time. 47 procedures take no input (`oc.output(...)` only).
- Runtime output validation and OpenAPI (`@orpc/openapi`) come free from the contract.

### R1.6 HTTP routes: inventory and verdicts (contract-first via `oc.route`, served by `OpenAPIHandler`)

One router, two handlers: `RPCHandler` at `/api/orpc/$` (today) and `OpenAPIHandler` (`@orpc/openapi/fetch`) at `/api/$`. A contract procedure gets an HTTP shape with `oc.route({ method, path })`; its path is what callers already use, so external callers (Coolify cron) change nothing. Inventory of `apps/avocabo/start/src/routes/api/**` (63 files, 15 tests):

| Routes | Count | Verdict |
| --- | --- | --- |
| `cron/*` (POST, `CRON_SECRET`) | 33 | contract: `oc.route({ method: 'POST', path: '/cron/<name>' }).output(runReportSchema)` in the owning feature's contract; `cronSecret` middleware; Coolify keeps POSTing the same path. Most duplicate a `schedules(needs, …)` slice — the handler calls the same service. |
| `e2e/*` (test seams) | 9 | contract, in an `e2e` feature mounted only when `E2E` is on (gate in `features.ts`). |
| `copilot/stream` (SSE) | 1 | contract: `oc.output(eventIterator(chunkSchema))` — oRPC streams event iterators over OpenAPI. |
| `digest/open`, `digest/pause`, `export-download`, `extension-token`, `fleet`, `health` | 6 | contract: `oc.route({ method: 'GET' \| 'POST', path })`; binary bodies (`open` pixel, export file) as `File` outputs with their content type. |
| `orpc.$` | 1 | the RPC mount; stays. `api.$` is added for `OpenAPIHandler`. |
| **Exempt** `auth.$` | 1 | Better Auth owns its routes and handler. |
| **Exempt** `webhooks/stripe`, `webhooks/email-inbound` | 2 | signature verified over the raw body; oRPC parses the body before the handler. Keep as Start file routes behind the existing HMAC/Stripe verification. |
| **Exempt** `audio/$fileId` | 1 | HTTP `Range` / 206 partial content; not an oRPC response shape. |

Exemptions live in `start/src/routes/api/exemptions.ts` — `[{ file, reason }]` — and nowhere else (test in R1.7).

`@arki/http` (Novelette server/backend, pidpadpod) is a second contract system: its own `ContractLike { kind, method, path, query?, body?, output? }` and `toOpenApi(contracts)`, no oRPC dependency; features declare `use: [endpoints(build)]`. It is already contract-first, but a different contract. Decision for the founder, not a blocker: converge on oRPC contracts (`oc.route` + `@orpc/openapi`) and either retire `@arki/http`'s contract layer or have `toOpenApi` consume oRPC contracts. Until then, Novelette/pidpadpod are contract-first under `@arki/http`; nothing there is router-first.

### R1.7 Guards for what types cannot catch

1. ESLint `no-restricted-imports` (backend): `@orpc/server` only in `core/orpc.ts`, `**/implementer.ts`, `root.ts`, `gateway.ts` — a bare `os` cannot appear in a procedure; `@orpc/contract` runtime import only in `**/contract.ts` and `src/contract.ts`; `**/contract.ts` may import only `@orpc/contract`, `zod`/`@arki/contracts`, `./schemas`.
2. ESLint (`start/**`, `extension/**`): `@avocabo/backend/*` forbidden except `/contract` and an explicit browser-safe allowlist; `consistent-type-imports`. (Today `start` value-imports `schema`/`db`/`env`/… in ~15 files; fix with the rule.)
3. Vitest "contract purity": import `@avocabo/backend/contract`, assert the module graph has no `features/**/{implementer,feature}.ts`, no `procedures/`, no `core/`.
4. Vitest "routes manifest": every file under `start/src/routes/api/**` (tests excluded) is `orpc.$.ts`, `api.$.ts`, or listed in `exemptions.ts` with a reason — a new raw route fails CI.
5. Type tests next to `core/orpc.ts` (the probe's `client-types.ts` + `enforcement-check.ts` as templates): seam, exact client types, the five rejections in R1.3.
6. `dot doctor`: router-without-contract and key-without-feature at boot. Prod `vite build` remains the final proof against runtime leaks.

### R1.8 Incremental migration

A feature converts whole (contract → implementer → procedures → feature). During the window the app router is `{ ...routerFor(partialAppContract, converted), ...composeRouter(legacy) }` and the browser keeps `RouterClient<AppRouter>`; when the last feature converts, `composeRouter` is deleted and the browser switches to `ContractRouterClient<typeof appContract>` (one import). Order: health and waitlist first to set the pattern, then by traffic; cron routes convert with their owning feature.

Per feature: contract (inputs mostly moved, outputs written), `implementer.ts` (two lines), per procedure `protectedProcedure.input(x)` → `os.<name>.use(authed)` and delete `.input(...)`, `router.ts` folded into `feature.ts`. Builder-import rewrite and `.input` move are regex codemods; output schemas are the human work. Avocabo: 21 features, 226 procedures, 33 cron + 20 other routes — ~2 days of schema authoring plus ~1 day of route conversion.

### R1.9 What belongs where; template

- `@arki/dot/feature`: `contract` field + `Router<TContract, never>` constraint on `router`; `routerFor`; `servicesOf` over `HasProvides[]` (plugins too); `dot doctor` codes. Type-only peer deps on `@orpc/*`.
- `@arki/dot/orpc` (new subpath; peer `@orpc/server`): `needsMiddleware<Ctx extends { services: ServicesBag }>()` → `(needs) => middleware` — the one commented erasure seam (oRPC's `IntersectPick` cannot be proven through a generic `N`), with its type test; `Shape<Ctx>` (no alias may shadow a request key). App: `export const bind = needsMiddleware<RequestContext>()`.
- App `core/orpc.ts`: `RequestContext`, `bind`, `authed`, `admin`, `cronSecret`, error-capture/timing bases, `ORPCError`. App `contract.ts`, `root.ts`, `gateway.ts` (`createContext({ headers, auth, services })`, `RPCHandler` + `OpenAPIHandler`).
- Template (`turbo/generators/templates/application/`): backend `core/orpc.ts` in this shape, `contract.ts` + `./contract` export, one example feature with the four files and one `oc.route` procedure, `start/src/lib/orpc/raw-client.ts` on `ContractRouterClient`, `routes/api/{orpc.$,api.$}.ts` + `exemptions.ts`, the ESLint rules and the two vitest guards. Template sync rule applies to every Avocabo change here.

### R1.10 Blockers: none real. Open risks

- Seam in `needsMiddleware` depends on oRPC 1.15's `IntersectPick` constraint; `Router<C, never>` depends on `Procedure`'s initial-context variance — both pinned by type tests.
- `@arki/dot` grows type-only `@orpc/*` peers; Dot's feature model becomes oRPC-shaped (founder intent, but it is a product decision for a general-purpose library).
- Two contract systems (`@arki/http` vs oRPC) until the convergence decision is made.
- `offlineSafe` (`core/offline.ts`) reads `context.db`; typed `{ db: Db }`, its misuse errors at the gateway, not the procedure.
- Output schemas are real authoring work; entity-schema-vs-table type tests must land with them or they drift silently.

---

## Original design (2026-10-15, superseded where Revision 1 says so)

Founder's question: "if DB and other services are accessible through context, why do we need `needs`? how do we control the deps? and how do we infer types end to end?"

Short answer: today `needs` does not control what procedures touch, because the gateway puts `db`/`kv` on every request context. Fix: the request context carries request data only; every service reaches a procedure through the feature's `needs`, via a procedure builder bound to those needs. Proved with a tsc + node probe (see § 6).

Probe: `scratchpad/avocabo-dot/probe/` — `node_modules/.bin/tsc -p tsconfig.json` exits 0, `node out/src/main.js` runs, `tsconfig.cycle.json` shows the import cycle.

---

## 1. The gap today (verified in code)

- `gateway.ts` takes `db`, `kv`, `auth` plus `providesOf(features)` in its own `needs`, then `createContext` puts `db` and `kv` on every request context (`core/context.ts:39-46`).
- Procedures use the ambient handle: 218 files, 249 `context.db` sites, 1 `context.kv` site (`waitlist/router.ts`). Only one procedure uses the typed door: `reader-companion/procedures/ingest-url.ts` with `needs({ entitlements: billing.provides.entitlements })`.
- `reader-companion/feature.ts` declares `needs = { db }` only. Its `ingest-url` procedure depends on billing. So the kernel does not order reader-companion after billing for that dependency, and `dot explain` draws no reader-companion → billing edge. That is the under-report, concretely.
- Feature-level `needs` only feeds `boot`, `provides` factories and `schedules(needs, …)`. The request path bypasses it.

So there are two doors to services: the declared one (`needs`) and the ambient one (`context.db`). The ambient one is the leak. The question "why needs if context has db" is right: as long as context has db, `needs` is decoration for procedures.

## 2. Decision

**Option (a), shaped as "needs-bound builders".**

- `RequestContext` (was `ORPCContext`) = `{ session, headers, authApi, services: ServicesBag }`. No `db`, no `kv`.
- `core/orpc.ts` exports ONE way to get a procedure builder: `procedures(needs)` → `{ publicProcedure, protectedProcedure, adminProcedure }`. Each builder's last middleware resolves the feature's `needs` from the opaque `services` bag and puts the values on the context **under their aliases**: `context.db`, `context.entitlements`, `context.kv`.
- The bare `publicProcedure` / `protectedProcedure` / `adminProcedure` exports and the per-procedure `needs()` middleware are removed. Nothing to lint: there is no builder without needs.
- Every feature gets a `needs.ts`:

```ts
// features/podcast-support/needs.ts
import { procedures } from '../../core/orpc';
import { database } from '../../db';

export const needs = { db: database.provides.db };
export const { protectedProcedure, publicProcedure, adminProcedure } = procedures(needs);
```

```ts
// features/podcast-support/feature.ts
import { needs } from './needs';
export const podcastSupport = feature('podcast-support', { needs, router: { podcasts: podcastsRouter }, use: [schedules(needs, …)] });
```

```ts
// features/podcast-support/procedures/process-episode.ts  (body unchanged)
import { protectedProcedure } from '../needs';
export const processEpisode = protectedProcedure.input(processEpisodeSchema).handler(async ({ context, input }) => {
  const repo = createPodcastSupportRepository(context.db);   // typed: Db — because needs.ts declared it
```

One record (`needs`) is the single source of truth for boot, schedules, factories, AND procedures.

### Options rejected

- (b) keep ambient db, lint-ban it: two sources of truth stay; lint does not feed the kernel or `dot explain`; a lint rule cannot type `context.kv` away.
- (c) `needs()` per procedure: 226 repetitions of what the feature already says; still ambient `db` unless you also do (a).
- Put `db` on the *initial* oRPC context per feature (`os.$context<RequestContext & CtxOf<needs>>()`): no middleware, but then the gateway would have to pass services under **aliases**, and aliases differ per feature (`cache` vs `kv`). Wire keys ≠ aliases, so resolution must happen per feature. The middleware is that resolution.

## 3. How deps are controlled

| Layer | What it checks | When |
| --- | --- | --- |
| TypeScript | `context.db` exists only if the feature's `needs` has `db`; `context.kv` is a compile error otherwise (probe: `get-plan.ts` has `@ts-expect-error` on `context.entitlements` and `context.kv`). An alias that shadows a request key (`session`, `headers`, `services`) is a compile error (`NoRequestKeys`). | edit time |
| Kernel | The same `needs` object becomes the plugin's needs via `plug()`: boot order, rings, "provider mounted later" (E019/E020) now cover procedure deps too. | boot |
| `resolveNeeds` | `FEATURE_E005` if a handle's wire key is not in the bag. Cannot happen in Avocabo because the gateway spreads `providesOf(...)`, but it is the fail-loud for a hand-built context. | request |
| `dot explain` | Edges come from feature `needs` — now complete, because procedures have no other door. | CLI |

Lint (belt and braces, one rule): `no-restricted-imports` — `features/**` may import `core/orpc` only from `needs.ts` (for `procedures`) and for `ORPCError`/`handleValidationError`. Optional; the type system already enforces the important part.

## 4. Types end to end (no type written twice)

`database.provides.db: Handle<Db,'db','database'>` → `needs` → `CtxOf<HandleEntries<N>>` = `{ db: Db }` → oRPC `MergedCurrentContext<Authed, { db: Db }>` in the handler → handler return type → router fragment → `composeRouter(features)` → `RouterClient<AppRouter>` → `createTanstackQueryUtils`.

Probe `src/client-types.ts` (all pass under `tsc`):
- `Parameters<Client['reader']['ingest']>[0]` is exactly `{ url: string }`.
- `Awaited<ReturnType<Client['reader']['ingest']>>` is exactly `{ id: string; plan: 'free' | 'pro' }` — `plan` flows from billing's factory return type through the handle, into the handler, out to the client.
- A wrong output shape is rejected (`@ts-expect-error`).
- `Client['reader']['db']` does not exist: the context never reaches the client type.
- `ContractRouterClient<AppRouter>` (from `@orpc/contract`) is the same type as `RouterClient<AppRouter>`.

Does `RouterClient<typeof appRouter>` force the context types? Yes, TS evaluates `typeof appRouter`, which carries each procedure's context type parameters. That is a **typecheck-time** cost only: the probe's browser module (`client-browser.ts`, `import type { AppRouter }`) emits JS whose only imports are `@orpc/client` and `@orpc/client/fetch`; `--listFilesOnly` for that module loads 11 `packages/dot` d.ts files and 0 drizzle files. In Avocabo, drizzle types do enter the client typecheck today through handler return types (row types); that is unchanged by this design.

## 5. The cycle, and why `needs.ts` is the norm

If the builder lives in `feature.ts` (`podcastSupport.procedure`), the graph is `feature.ts → router.ts → procedures/*.ts → feature.ts`. Probe `cycle/`:
- tsc: `TS7022 'cyclic' implicitly has type 'any' because it ... is referenced directly or indirectly in its own initializer` (a **type** cycle: `typeof feature` includes the router, which includes the procedure, which is typed from the feature).
- node: `ReferenceError: Cannot access 'cyclic' before initialization` (ESM TDZ at import).

`needs.ts` breaks both: it imports only infra plugins and *other* features' `feature.ts`, never its own. Graph: `feature.ts → {needs.ts, router.ts}`, `procedures → needs.ts`. Cross-feature cycles (A needs B, B needs A) are already forbidden by boot order, so a `needs.ts` can safely import another feature's `feature.ts`. Rule: **`needs.ts` never imports its own `feature.ts`; `feature.ts` imports `needs.ts`.** Yes, it becomes the norm — one file per feature, three lines. The alternative (builder inside `feature()`'s return) cannot work for the two reasons above; `Object.assign(feature(...), { procedure })` was the probe's cyclic version.

## 6. The one typing seam (core/orpc.ts, proved)

oRPC's `use<UOutContext extends IntersectPick<TCurrentContext, UOutContext>>` requires that a middleware's added context not conflict with the current context on shared keys. With a generic `N`, TS cannot see that `NoRequestKeys` already guarantees "no shared keys". Three shapes were tried; the one that typechecks with `procedures()` generic:

```ts
type Base<C extends Context> = BuilderWithMiddlewares<RequestContext, C, Unit, Unit, None, ORPCMeta>;

const bound = <C extends RequestContext, N extends Shape>(base: Base<C>, needs: N) =>
  base.use(os.$context<C>().middleware(({ context, next }) => next({
    // Erasure seam: `Shape` forbids any alias that is a request-context key, so the overlap
    // oRPC checks here (`IntersectPick`) is empty; TS cannot carry that proof through generic C/N.
    context: resolveNeeds(context.services, needs) as Bound<N> & IntersectPick<C, Bound<N>>,
  })));

export const procedures = <N extends Shape>(needs: N) => ({
  publicProcedure: bound(publicBase, needs),           // errorCapture + timing
  protectedProcedure: bound(protectedBase, needs),     // + auth (branded UserId)
  adminProcedure: bound(adminBase, needs),             // + auth + admin
});
```

Rules that fell out of the probe:
- `bound` is always the **last** middleware. Request-level middleware (auth, admin) is typed against `RequestContext` and must come before. A generic middleware applied *after* the bind cannot prove the context still has `session` (tried; fails).
- `BuilderWithMiddlewares`, `Context`, `Schema` are exported by `@orpc/server` 1.15.5. `Base<C>` must use Avocabo's `ORPCMeta` as TMeta.
- `core/offline.ts` (`offlineSafe`) reads `options.context.db`; type it `os.$context<{ db: Db }>()`. Applied after `bound`, it is satisfied when the feature declares `db`; if not, the error surfaces at `createRouterClient`/`RPCHandler` in the gateway ("context lacks db"), not at the procedure. Acceptable; note in a comment.

## 7. Gateway and `@arki/dot` changes

- `createContext({ headers, auth, services })` — drop `db`, `kv`.
- The bag must also hold plugin-provided values (`db`, `kv`), not just feature ones. Today `servicesOf(ctx, features)` copies feature provides only. Change `@arki/dot`: `servicesOf` (and `ServicesOf`) accept `readonly HasProvides[]` (features and plugins), same as `providesOf` already does. Gateway: `servicesOf(ctx, [database, cache, ...features])`. Small, additive; minor changeset (0.x rule).
- `resolveNeeds` doc says "driven services (`db`) drop out". With `database` a plugin, `db` is a handle with a `provider`, so it resolves. Update the comment; behaviour is already right.
- Backend `index.ts`: `export type { ORPCContext }` → `RequestContext` (only `core/offline.ts` uses it in-repo).

## 8. Frontend (founder additions #1 and #2)

Facts: `start/src/lib/orpc/raw-client.ts` does `import type { appRouter } from '@avocabo/backend'` and builds `RouterClient<typeof appRouter, AvocaboRpcContext>`; ~87 call sites via `createTanstackQueryUtils`. SSR uses `gateway.rpc.client(headers)`. The extension calls string paths. 0 of 226 procedures have `.output()`.

### Keep router-type inference. Do not go contract-first.

| | `import type { AppRouter }` (today) | contract-first (`@orpc/contract`) |
| --- | --- | --- |
| Types written once | yes: input schema + handler return | **no**: 226 output schemas must be written; the handler already states the type. `drizzle-zod` generation would pull drizzle into the contract module — the very thing it tries to avoid |
| Runtime leak into browser | none with `import type` (probe emit: zero backend imports) | none |
| Server types in client typecheck | yes (dot, drizzle row types) — typecheck only | none, if outputs are hand-written |
| Extension typed client | free: `RouterClient<AppRouter>` with `createORPCClient`, paths unchanged | same |
| Migration | 0 call sites; 1 import path | 226 procedures + 21 features + shared package |

The founder's own rule ("every type written once") decides it: contract-first restates every output. The remaining cost of the current approach (server d.ts in the client typecheck) is accepted; it never reaches the bundle.

### What to tighten (small, mechanical)

1. Types-only entry: `backend/src/api.ts` = `export type { AppRouter } from './root';` mapped as `@avocabo/backend/api` (today `./api` points at `root.ts`, a runtime module — change it). `raw-client.ts`: `import type { AppRouter } from '@avocabo/backend/api'`.
2. ESLint in `start/` and `extension/`: `no-restricted-imports` — `@avocabo/backend` and `@avocabo/backend/*` forbidden except `@avocabo/backend/api` (type-only) and an explicit allowlist of browser-safe subpaths (`billing/plan-catalog`, `content`, `_shared` — audit each; today `start` value-imports `schema` (6 files), `db` (1), `env` (3), `waitlist`, `newsletter-ingestion` …, which is the known leak class). Plus `@typescript-eslint/consistent-type-imports`.
3. Import-purity test (vitest, `start`): import `@avocabo/backend/api` and assert the module graph contains no `backend/src` runtime file — or keep relying on the prod `vite build` lane; the lint rule is the cheap guard, the build is the proof.
4. Optional: the extension's `rpc<TOutput>(path, input)` becomes `createORPCClient<RouterClient<AppRouter>>(link)` — same string paths on the wire, typed at the call site.

## 9. Migration cost (Avocabo) and codemod

Numbers: 21 features (19 declare `needs`; 17 are the single line `needs = { db: database.provides.db }`; billing/relevance/waitlist add one more entry). 226 procedure files; builder imports: 214 `protectedProcedure`, 6 `adminProcedure`, 1 `publicProcedure`. 1 per-procedure `needs()` (ingest-url). Non-procedure `context.db` users: `core/offline.ts`, `waitlist/router.ts` (inline procedures; uses `context.kv` too), `podcast-support/repository.ts` (comment only).

Codemod (yes, mechanical; tsc drives the rest):
1. Per feature: create `needs.ts` by moving the `const needs = {…}` line out of `feature.ts`, append the `procedures(needs)` destructure; `feature.ts` imports `{ needs } from './needs'`. 21 files, regex-able (the line shape is uniform).
2. Per procedure: rewrite the import of `protectedProcedure|adminProcedure|publicProcedure` from `'../../../core/orpc'` to `'../needs'`; `ORPCError`/`handleValidationError` keep coming from `core/orpc`. 226 files, one sed with two capture groups.
3. `ingest-url.ts`: delete the `.use(needs(...))` line, use `context.entitlements`; add `entitlements: billing.provides.entitlements` to `reader-companion/needs.ts` (this is the missing edge from § 1).
4. `waitlist`: `needs.ts` with `db` + `kv: cache.provides.kv`; its inline procedures use the bound builders.
5. `core/orpc.ts`: replace the three exports + `needs()` with `procedures()` (§ 6). `core/context.ts`, `gateway.ts` (§ 7). `core/offline.ts` in-context `{ db: Db }`.
6. Run `turbo typecheck --filter=@avocabo/backend`: any feature whose procedures use `context.db` but whose `needs` lacks it fails on the exact line. Two features have no `needs` today; add as the errors say.
7. Tests: 0 test files hand-build an oRPC context; app-harness tests boot the graph and go through the gateway, and `fake(database.provides.db, db)` keeps working, because the bag is filled from the graph.

Estimate: half a day with the codemod, plus the `@arki/dot` `servicesOf` change and its changeset.

## 10. Open risks

- The seam in `bound()` depends on oRPC's `IntersectPick` constraint and on `BuilderWithMiddlewares` being exported (1.15.5). Pin with a type test next to `core/orpc.ts` (the probe's `client-types.ts` is the template) so an oRPC bump that changes the constraint fails loudly.
- `offlineSafe` mis-declaration errors at the gateway, not the procedure (§ 6). Clear message, wrong place.
- Backend `dist/index.d.ts` staleness (known trap) still governs what the client typechecks against; the types-only entry does not change that.
- `@arki/dot` `servicesOf` generalization touches a public API — needs its type test and README line.
- The browser-safe subpath allowlist (§ 8.2) will surface today's value imports of `schema`/`db`/`env` from `start`; fixing those is separate work, but the rule should land with the allowlist, not after.

---

# Part C

# A Dot feature that feels like the app definition — shapes and a recommendation (Fable, 2026-10-15)

Baseline kept: contract-first Revision 1 (`contract.ts`, `implementer.ts`, `procedures/`, `feature.ts`; `routerFor`; the enforcement list). This note says where those files land once a feature has layers. Probe: `scratchpad/avocabo-dot/probe/hex/` — `tsc -p tsconfig.hex.json` exit 0, `node out/hex/main.js` boots a real Dot app twice (drizzle adapter, then `fake()`), and `tsconfig.hexclient.json --listFilesOnly` shows the contract pulls only `model/schemas.ts`.

## What the code says today

- An app is adapters → features → serving adapters: `apps/novelette/backend/src/app.ts:2-8` states it; Avocabo wires `database`/`cache`/`authn` then `.features([...features, gateway])` (`start/src/lib/app.server.ts:19-20`).
- A feature folder mixes every layer: `daily-digest/` has `tables.ts`, `repository.ts` (730 lines), `services/` (23 files, email JSX included), `procedures/`, `router.ts`, `validation.ts`, `types.ts`, `primitives.ts`, `feature.ts`, and an `index.ts` barrel that re-exports the repository and services to other features (`daily-digest/index.ts:1-20`).
- Layer leaks the folders hide: `services/digest-tier-policy.ts:1` imports `../../billing/types` (another feature's internals, not a handle); `services/send-due-digests.ts:18-19` imports `Database` and `env` into orchestration code; `tables.ts:5` imports `./types` for jsonb columns.
- Dot already has the port vocabulary: `needs` are handles typed by their provider (`packages/dot/src/plugin-contract.ts:370-389`), `provides` factories get `CtxOf<needs>` (`feature.ts:141-160`), `fake(handle, value)` swaps a provider in tests (`test-harness.ts:229`). A `repos` slot exists (`feature.ts:292-325`) but Avocabo does not use it.
- The dependency rule between `@arki/*` packages is already a lint gate (`arki-layers`, `docs/rfcs/2026-10-14-arki-structure.md:18`). Nothing equivalent exists inside an app.

## Shape 1 — named flat (files by kind, no layer folders)

Keep one folder; every file is named for its kind.

```
highlights/                              daily-digest/
  contract.ts  implementer.ts              contract.ts  implementer.ts
  model.ts  tables.ts  ids.ts              model.ts  tables.ts  ids.ts  schemas.ts
  store.ts            (was repository)     store.ts
  procedures/  schedules.ts                procedures/  schedules.ts
  use-cases/ (export, import, discover)    use-cases/ (compile, deliver, extras, …)
  feature.ts                               adapters/email/ (renderer + 14 sections)
```

Pros: smallest move; thin features stay small. Cons: the layer is a naming convention, not a boundary — lint cannot address "the model" as a path; daily-digest's 23 service files still need sub-folders, so the thick feature grows folders the thin one lacks, breaking "same names everywhere".

## Shape 2 — four folders: `model/`, `use-cases/`, `adapters/`, `api/`

The layers are the folders. Same four names in every feature; a thin feature just has fewer files in each.

```
highlights/                                   daily-digest/
  model/                                        model/
    schemas.ts  (zod, browser-safe)               schemas.ts  types.ts  ids.ts  tables.ts
    types.ts  ids.ts  tables.ts                   tier-policy.ts  (pure rule, was services/digest-tier-policy)
  use-cases/                                    use-cases/
    ports.ts  (HighlightStore, Embeddings)        ports.ts  (DigestStore, PlanLookup, Mailer, Extras)
    export-due-highlights.ts                      compile-due-digests.ts  send-due-digests.ts
    import-from-csv.ts  import-from-readwise.ts   compile-digest.ts  deliver-digest.ts
    discover-connections.ts                       first-digest-fast-path.ts  theme-intro.ts
  adapters/                                     adapters/
    drizzle-store.ts  (was repository.ts)         drizzle-store.ts
    export/ (csv, json, notion, …)                email/ (renderer, components, sections/*, theme)
    embedding-provider.ts                         signal-writeback.ts
  api/                                          api/
    contract.ts  implementer.ts                   contract.ts  implementer.ts
    procedures/*.ts  schedules.ts                  procedures/*.ts  schedules.ts
  feature.ts                                    feature.ts
```

| Folder | Layer | Holds | Dot primitive |
| --- | --- | --- | --- |
| `model/` | domain | `schemas.ts` (zod shapes that cross the API), `types.ts` (branded ids, derived types), `ids.ts`, `tables.ts` (drizzle), pure rules | none — data and functions |
| `use-cases/` | application | `ports.ts` (what the feature needs from outside, written once), one file per use case taking ports | `CtxOf<needs>` is the deps type |
| `adapters/` | infra | each port's implementation: store (drizzle), email, external clients | `plugin()` per adapter; the factory is annotated with the port |
| `api/` | interface | `contract.ts`, `implementer.ts` (`needs` + `os`), `procedures/`, `schedules.ts`, routes | `contract`, `router`, `schedules(needs, …)` |
| `feature.ts` | wiring | `feature(name, { contract, router, needs, adapters, provides, boot, use })` | the feature |

Why `tables.ts` is model, not adapter: a drizzle table is a declaration with no IO; its row types are the feature's record types written once (`$inferSelect`). Putting tables in `adapters/` forces either a restated domain type or `model → adapters` imports. The pool, migrations and drizzle-kit are app-level infra (`backend/src/db.ts`). `model/schemas.ts` is browser-safe and is what `api/contract.ts` imports — the probe hit this exactly: a hand-written `Digest` type (`readonly string[]`) and a zod output (`string[]`) were the same shape twice and failed to typecheck until the model type became `z.infer<typeof digestSchema>`.

Mirror of the app: `backend/src/` is the same tree one level up — `db.ts`, `kv.ts`, `core/auth` are the app's `adapters/`; `content/` (`tables.ts`, `types.ts`, `primitives.ts`) is the shared `model/`; `contract.ts`, `root.ts`, `gateway.ts`, `core/orpc.ts` are the app's `api/`; `features/` sit between. Renaming those app folders to `adapters/`, `model/`, `api/` is optional and makes the mirror literal.

Pros: a newcomer finds a rule, a use case, a table, an adapter, a contract or a schedule without reading code; lint can name each layer by path; thin and thick use the same names. Cons: one more folder level; ports must be written for stores (see "types flow").

## Shape 3 — feature as a mini-app (builder vocabulary + private adapters)

Same folders as Shape 2; the difference is `feature.ts`: the feature mounts its own adapters the way the app mounts plugins, so the adapter is a kernel unit — ordered after `db`, visible to `dot explain` as `daily-digest › store`, swappable with `fake()`.

```ts
export const dailyDigest = feature('daily-digest', {
  adapters: [digestStore, digestMailer],                      // feature-private plugins (new slot)
  needs: { store: digestStore.provides.store, mailer: digestMailer.provides.mailer, plans: billing.provides.entitlements },
  contract: digestContract,
  router: os.router({ previewNext, provideFeedback, … }),
  use: [schedules(needs, [{ name: 'send-digest', cron: '*/15 * * * *', handler: sendDueDigests }])],
});
```

Probe (`hex/digest/`): `digestStore` is a `plugin()` with `needs: { db }` and `provides: { store: ({ db }): DigestStore => … }`; the handler sees `context.store` typed as the port; `context.db` is a compile error; `defineApp().use(database).use(digestStore)` returns the drizzle store, `defineApp().use(fake(digestStore.provides.store, fakeStore))` returns the fake; `plug(digest).needs` → `['store', 'plans']`, so `dot explain` draws feature → store → db. A chain form (`defineFeature('x').use(store).serve(contract)`) was considered and dropped: `feature()`'s object already infers `provides` from `needs`, and a chain adds nothing but a second syntax.

Pros: the feature reads like `app.ts`; tests swap adapters without mocking modules; the kernel owns adapter order. Cons: one `@arki/dot` change (`adapters` slot); each store becomes a plugin (one `plugin({ … })` wrapper per feature).

## Shape 4 — thick feature = folder of thin features

`daily-digest/` becomes `digest/{preferences,compile,deliver,feedback}/`, each a Shape-1 flat feature, sharing `digest/model/`. Pros: every unit is small. Cons: four contracts and mount keys for one product area; cross-sub-feature calls go through handles (`compile.provides.compiler`) — ceremony for what is one transaction today; the thin/thick asymmetry the founder wants gone comes back as "which features are folders of features".

## Types flow with nothing written twice ("port = interface" reconciled)

The rule is: each shape is written once; everything else is derived or checked against it.

- API shapes: `model/schemas.ts` (zod) → `model/types.ts` (`z.infer`) → `api/contract.ts` reuses the schema → client.
- Records: `model/tables.ts` → row types (`$inferSelect`) → stores and use cases.
- Ports: `use-cases/ports.ts` is the one writing. The adapter does not declare a type; its factory is **annotated** with the port (`({ db }): DigestStore => …`), so the implementation is checked, not restated. The Dot handle is typed by the factory, so `Provided<typeof digestStore.provides.store>` is literally `DigestStore` (probe `hex/types-check.ts`: `Eq<…> = true`). `needs` carries it to `implementer.ts` → handler context, and to `schedules(needs, …)` → use case deps. The alternative — port = `ReturnType<typeof createStore>` — is also written once but points the type arrow outward (use cases import from adapters); it is rejected because it makes the dependency rule unenforceable.
- Cross-feature: a feature imports another feature only through `feature.ts` (handles) and `model/schemas.ts` / `api/contract.ts` (schemas and types). `digest-tier-policy.ts`'s `SubscriptionPlan` comes from `billing/model/schemas.ts`, not `billing/types`.

Cost of ports: a store port lists the methods use cases and procedures call. Highlights' repository (635 lines) has explicit method signatures already; moving them to `ports.ts` and leaving bodies in `adapters/drizzle-store.ts` is a cut-and-paste, not a second writing.

## Enforcing the dependency rule

Types cannot see folders, so the rule is lint plus a test:

1. ESLint `no-restricted-imports` overrides by glob, one preset in `tooling/eslint` (`feature-layers`): `model/**` may import `zod`, `@arki/date`, `drizzle-orm/pg-core`, `@arki/db/{id,temporal}`, `content/`; `use-cases/**` may import `../model`, `./ports`, `@arki/log`; `adapters/**` may import `../model`, `../use-cases/ports`, app adapters (`db.ts`, `kv.ts`), libraries; `api/**` may import `../use-cases`, `../adapters` (handles), `../model/schemas`, `core/orpc`; `feature.ts` may import `./api`, `./adapters`; any `features/<other>/*` import must be `feature.ts`, `model/schemas.ts` or `api/contract.ts`. Barrels (`index.ts`) are forbidden in features — today's `daily-digest/index.ts` is how internals leak.
2. Vitest import-graph test over `features/*/` (regex on import lines, no new dependency) asserting the same matrix, so a lint-disable cannot hide an edge; the existing contract-purity and routes-manifest tests from Revision 1 stay.
3. Type level: `context.db` does not exist in a handler unless the feature declared `db` (Revision 1); with ports, a feature that needs `db` directly is visible in `dot explain` and in review — the probe shows `context.db` rejected when only ports are declared.

## Recommendation: Shape 2 folders with Shape 3's adapters slot

One tree for every feature (`model/`, `use-cases/`, `adapters/`, `api/`, `feature.ts`); stores are feature-private Dot plugins; ports are written once in `use-cases/ports.ts`. No "earned hexagon" variant: a thin feature has few files per folder, never different folder names. `use-cases/` holds orchestration only; a procedure that calls one store method calls the port from the handler (`context.store.list(userId)`) and does not get a one-line use case file.

What belongs in `@arki/dot`: the `adapters` slot on `feature()` (mounted before the feature, named `<feature>.<adapter>`, nested in `dot explain`), plus Revision 1's `contract`/`routerFor`/`servicesOf` changes and the `needsMiddleware` seam in `@arki/dot/orpc`. In `tooling/eslint`: the `feature-layers` preset. In the app: `core/orpc.ts`, `contract.ts`, `root.ts`, `gateway.ts`, the four folders per feature, the import-graph test. Template: one example feature with the four folders, a store plugin, one port, one use case, one `oc.route` procedure, one schedule.

Migration per feature, done in the same pass as the contract-first conversion: `tables.ts`, `types.ts`, `primitives.ts`, `validation.ts` → `model/` (schemas split out, types derived); `repository.ts` → `adapters/drizzle-store.ts` + its signatures → `use-cases/ports.ts`; `services/*` sorted by what they do — pure rules → `model/`, orchestration → `use-cases/`, renderers and external clients → `adapters/`; `procedures/`, `router.ts` (folded into `feature.ts`), schedules → `api/`; delete `index.ts`. Fix the two kinds of leak the lint will surface (`env` in use cases, other features' `types`). Avocabo: 21 features; highlights ≈ half a day, daily-digest ≈ 1.5 days (the email adapter is the bulk), most CRUD features ≈ 2 hours — ~8 days total after the contract-first pass, mechanical except the port extraction and the `services/` sort.

Open risks: `adapters` slot is a kernel change (ordering, naming, `dot explain` rendering); the lint preset must be byte-exact per layer or it becomes advisory; `model/tables.ts` means a rule file sits next to a drizzle file — acceptable, both are declarations.

---

# Part D

# `@arki/journal` inside the layered Dot feature (Fable, 2026-10-15)

Facts checked: a command is `j.command(name, inputSchema, run)` and exposes its schema as `.input` (`packages/journal/src/api.ts:82-83`); events are name + zod (`README.md` Example); effects list services with `need<T>()` and get them from the listing feature's `needs` (README § Dot); `journal()` is the driven adapter, `journalWorker()` the driving one, `journalHandlers()` a feature slice (`src/dot.ts:113,284,337`); effects are already manifest actions, projections are not (README § Dot). Today's journal features are flat: Foreman's `ops-agent/journal.ts` holds events, entity and commands in one file.

## 1. Where each journal kind lives — no different structure

The journal adds kinds of file, not layers. Same four folders; a journal-backed feature simply has these files:

| Kind | Folder | File | Why |
| --- | --- | --- | --- |
| `j.event` | `model/` | `events.ts` | an event is a fact about the model: a name and a zod shape |
| `j.entity(...).create().on()` | `model/` | `<entity>.ts` next to `tables.ts` | reducers are pure rules from events to the row |
| input schemas | `model/` | `schemas.ts` | shared by the command and the contract (see 2a) |
| `j.command` | `logic/` | `commands.ts` | a command is a use case that writes |
| `j.projection` (inline) | `logic/` | `projections.ts` | a read model kept in the same transaction |
| `j.effect` | `logic/` | `effects.ts` | a use case started by an event; its services are ports typed by `needs` |
| mailer, LLM, scraper | `infra/` | plugins, as before | what effects talk to |
| `journal_events`, `journal_jobs` | app `model` | `schema/journal.tables.ts` (everseek does this) | app-wide tables |
| `context.run(...)`, `commandErrors()` | `serve/` + app `core/orpc.ts` | procedures | the door is request-scoped |
| `journalHandlers({...})` | `feature.ts` | with `schedules(...)` | a slice is wiring |

Lint allowance: `model/` may import `@arki/journal` core and the app's `journal.ts` (`j`); both are IO-free.

## 2. `defineFeature` integrations — payoff vs machinery

**a. Commands implementing contract entries — yes, by sharing the schema, not by deriving.** `contract.ts` must stay browser-safe; a command file imports `j` and the entity (drizzle tables), so a `fromCommand(payOrder)` contract helper would drag the server into the browser. Instead the input schema lives once in `model/schemas.ts`; `logic/commands.ts` and `serve/contract.ts` both import it. Zero machinery; written once.

**b. `context.run` bound to the actor — yes, one middleware in the app.** The gateway binds today (`services.journal.bind(services.db, { actorId })`, README § Dot). With the request context holding only session/headers/services, the bind moves to `core/orpc.ts`:

```ts
export const asActor = base.middleware(({ context, next }) => {
  if (!context.session) throw new ORPCError('UNAUTHORIZED');
  return next({ context: { session: context.session, run: context.journal.bind(context.db, { actorId: context.session.user.id }) } });
});
```

It typechecks only after `bind(needs)` put `journal` and `db` on the context, so a feature that writes declares `needs: { journal: journal.provides.journal, db: database.provides.db }` — and `dot explain` shows feature → journal → db for free. Five lines, no Dot change. `commandErrors()` from `@arki/journal/orpc` goes once on the base builder.

**c. Effects/projections registered by the builder step instead of `journalHandlers` — no.** `.logic(compileDigest, orderMail)` could sniff `j.effect` objects, but then Dot must know the journal's shapes (or the journal must publish a second protocol). `journalHandlers` already is the structural slice protocol (`FeatureSlice`, `feature.ts:67`), one line per feature, and it works for the three other apps that use the journal today. Keep it; it goes where `schedules(...)` goes.

**d. `dot explain` event → effect edges — yes, small.** Effects are actions already; `journalHandlers` builds their meta (`JournalDotAction`, `dot.ts:52`). Adding `events: Object.keys(on)` to that meta lets the renderer draw `OrderPaid → order-mail`. A few lines in `@arki/journal/dot` plus one renderer case; the reactive graph is the part nobody can see today.

Rejected: a journal "mode" of `defineFeature`, journal-specific folders, contracts generated from commands.

## 3. App chain

```ts
export const app = defineApp('avocabo')
  .infra(database, cache, authn, journal({ j, tables: journalTables() }))   // driven: publishes services.journal, reads the features' journalHandlers
  .features(features)
  .serve(gateway, schedule({ clock: 'host' }), journalWorker());             // driving: runs effects, taps, async projections
```

`journal()` must come after `database` (it needs `db`); the builder guard already checks order. A process that serves no worker still writes (README § Dot).

## 4. Worked example — reader-companion, journal-backed, beside plain highlights

```
reader-companion/                                  highlights/            (plain CRUD, unchanged)
  model/   schemas.ts  tables.ts  ids.ts              model/   schemas.ts  tables.ts  ids.ts
           events.ts   capture.ts                     infra/   drizzle-store.ts  export/  embedding-provider.ts
  infra/   distiller.ts  (LLM client plugin)          serve/   contract.ts  implementer.ts  procedures/  schedules.ts
  logic/   commands.ts  effects.ts                    feature.ts
  serve/   contract.ts  implementer.ts  procedures/
  feature.ts
```

```ts
// model/events.ts
export const CaptureRequested = j.event('CaptureRequested', captureRequestSchema);
export const CaptureDistilled = j.event('CaptureDistilled', distilledSchema);
// model/capture.ts
export const capture = j.entity('capture', companionCaptures).create(CaptureRequested, e => ({ ...e.data, outcome: 'pending' })).on(CaptureDistilled, e => ({ outcome: 'ready', summary: e.data.summary }));
// logic/commands.ts
export const ingestUrl = j.command('ingestUrl', ingestUrlSchema, (input, { write }) => write(capture, newCaptureId(), () => [CaptureRequested(input)]));
// logic/effects.ts
export const distill = j.effect('distill', capture, { distiller: need<Distiller>() }, { CaptureRequested: (e, { run, distiller }) => distiller.summarize(e.data.url).then(summary => run(markDistilled, { id: e.entityId, summary })) });

// feature.ts
export const readerCompanion = defineFeature('reader-companion')
  .needs({ journal: journal.provides.journal, db: database.provides.db, plans: billing.provides.entitlements })
  .infra(distiller)
  .logic(ingestUrl, distill)
  .serve(rpc(companionContract, procedures), journalHandlers({ effects: [distill] }));

// serve/procedures/ingest-url.ts
export const ingestUrlProcedure = os.ingestUrl.use(asActor).handler(({ context, input }) => context.run(ingestUrl, input));
```

`serve/contract.ts` has `ingestUrl: oc.input(ingestUrlSchema).output(captureSchema)` — the same `ingestUrlSchema` the command validates. Highlights next to it has no `logic/`, no events, and the same four names.

## Recommendation

No special structure and no journal mode in `defineFeature`. Events and entities are `model/`, commands/projections/effects are `logic/`, services are `infra/`, the door is a procedure middleware. Three small things earn their keep: the shared input schema in `model/schemas.ts` (write once, browser-safe contract), the `asActor` middleware in the app's `core/orpc.ts` (bind once, typed by `needs`, visible to `dot explain`), and event names in the effect action meta so `dot explain` draws event → effect edges. Everything else stays as `@arki/journal/dot` ships it.

---

## Part D, review (Astra)

**Category: Clean & elegant.** Use the same feature structure for journal-backed and CRUD features. Journal changes the adapters and use cases inside it; a second structure would duplicate conventions.

The names `infra`, `logic`, and `serve` below remain provisional. Builder examples are proposed syntax, not current APIs.

| Folder | Journal responsibility |
|---|---|
| `model/` | Event schemas, `j.event` declarations, pure decisions and reducer functions. Keep browser-safe schemas in separate files from server-only journal declarations. |
| `infra/` | Tables, `j.entity(...).create().on()` bindings, reads, and `j.projection` definitions. Entity bindings attach the model’s reducers to persistence. |
| `logic/` | `j.command` use cases: authorization, decisions, and writes through supplied capabilities. |
| `serve/` | oRPC procedures, `j.effect` consumers, and taps. Consumers invoke application behavior; mail/database implementations remain driven adapters. |
| `feature.ts` | Composition, capability handles, and registration. |
| `contract.ts` | Browser-safe oRPC contract importing only schemas and other browser-safe contracts. |

The entity binding belongs outside pure `model/` because its API takes a table. Commands receive that binding through the inferred `infra` capability, avoiding runtime imports from `logic/` into `infra/`. This keeps application orchestration journal-aware without adding port files. [api.ts:424](/Users/afurculita/Developer/workspace/packages/journal/src/api.ts:424)

Projections default to the write’s transaction; async projections still belong in `infra/` because they maintain persistence. Effects run after commit; taps are lossy notifications and cannot run commands. [README.md:327](/Users/afurculita/Developer/workspace/packages/journal/README.md:327), [README.md:88](/Users/afurculita/Developer/workspace/packages/journal/README.md:88), [README.md:400](/Users/afurculita/Developer/workspace/packages/journal/README.md:400)

Only create populated folders.

The integration choices are:

| Candidate | Payoff versus machinery |
|---|---|
| Commands automatically implement contract entries | **Skip.** An explicit one-line procedure preserves authorization and output mapping. Automatic matching introduces naming rules and assumes every command is public. |
| Contract inputs derived from commands | **Share schemas instead.** Both `oc.input(schema)` and `j.command(name, schema, …)` consume one definition. Importing `command.input` into the browser contract can pull in its server dependencies. Commands already expose their schema. [api.ts:81](/Users/afurculita/Developer/workspace/packages/journal/src/api.ts:81) |
| Actor-bound `context.run` | **Worth a middleware helper in `@arki/journal/orpc`.** The application supplies the authenticated actor selector; needs middleware supplies journal/database capabilities. Dot must not assume a session shape or choose an actor. Binding already exists. [llms.txt:30](/Users/afurculita/Developer/workspace/packages/journal/llms.txt:30) |
| Registration in each layer | **Worth thin adapter-owned descriptors:** `journalProjections(...)` in `.infra`, `journalEffects({ effects, taps })` in `.serve`. Normalize them into one internal journal slice before boot. No journal-specific methods in Dot core. |
| `dot explain` event → effect edges | **Worth rendering existing metadata.** Effect actions already record entity kinds and event types. Show declared subscriptions, without inferring command → event edges from arbitrary code. [dot.ts:84](/Users/afurculita/Developer/workspace/packages/journal/src/dot.ts:84) |

Layer registration needs an actual collector change: today it finds one `journal` slice in `feature.use`. Splitting declarations without normalization would lose handlers. Preserve static collection and feature-scoped dependency validation. [dot.ts:239](/Users/afurculita/Developer/workspace/packages/journal/src/dot.ts:239), [dot.ts:113](/Users/afurculita/Developer/workspace/packages/journal/src/dot.ts:113)

For a hypothetical journal-backed daily digest:

```text
features/
  daily-digest/
    feature.ts
    contract.ts
    model/{schemas,events,reducers}.ts
    infra/{tables,entity,feed}.ts
    logic/commands.ts
    serve/{rpc,delivery}.ts
  preferences/                   # ordinary CRUD
    feature.ts
    contract.ts
    model/schemas.ts
    infra/repository.ts
    logic/preferences.ts
    serve/rpc.ts
```

```ts
const digest = defineFeature('daily-digest')
  .needs({ db: dbHandle, journal: journalHandle,
           mailer: mailerHandle, articles: reader.provides.articles })
  .infra(digestStorage, journalProjections(digestFeed))
  .logic(digestCommands)
  .provides({ requestDigest: s => s.requestDigest })
  .serve(digestRpc, journalEffects({ effects: [deliverDigest] }));

const preferences = defineFeature('preferences')
  .needs({ db: dbHandle })
  .infra(preferenceRepository)
  .logic(preferenceLogic)
  .provides({ preferences: s => s.preferences })
  .serve(preferenceRpc);
```

`requestDigest` uses `write` to emit `DigestRequested`; the reducer creates the row, the projection updates the feed, and the effect handles delivery. The command returns the receipt defined by the shared output schema.

```ts
// contract.ts — schemas imported directly from model/schemas.ts
export const contract = {
  request: oc.input(requestInput).output(requestReceipt),
};

// serve/rpc.ts
const api = implement(contract).$context<RequestContext>()
  .use(appErrors)
  .use(commandErrors())
  .use(digestNeeds);

export const request = api.request.handler(({ context, input }) =>
  context.run(context.services.requestDigest, input));
```

Here `digestNeeds` requires an authenticated session, resolves the declared capabilities, and adds `run` using `journal.bind(db, { actorId: session.user.id })`. Actor binding does not replace command authorization. Error middleware order matches the existing adapter. [orpc.ts:43](/Users/afurculita/Developer/workspace/packages/journal/src/orpc.ts:43)

At app level:

```ts
defineApp('reader')
  .infra(dbAdapter, mailAdapter, journal({ j, tables }))
  .features([reader, digest, preferences])
  .serve(httpGateway, journalWorker());
```

Today those app steps are `.use()` and `.serve()`. Journal composition precedes feature boot; worker execution starts afterward and resolves services from each handler’s owning feature. Features without journal declarations contribute nothing. [dot.ts:298](/Users/afurculita/Developer/workspace/packages/journal/src/dot.ts:298), [dot.ts:337](/Users/afurculita/Developer/workspace/packages/journal/src/dot.ts:337), [dot.ts:239](/Users/afurculita/Developer/workspace/packages/journal/src/dot.ts:239)

**Recommendation:** keep one feature structure, with journal-owned layer descriptors, explicit contract implementations, and request-scoped actor binding; keep Dot’s core journal-agnostic.