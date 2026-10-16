# Plan: `feature.instance('eu')` — one feature, mounted twice

Gap 10 of `docs/arki/research/09-di-typing/synthesis.md`: a feature's name is fixed at `defineFeature(name)`, so
`.features([reports, reports])` collides (`DuplicatePlugin`, then `ServiceCollision`). A multi-tenant app wants the same
feature twice — once per region, each on its own database — without a second declaration.

## Goal and evidence

`reports.instance('eu', { db: databaseEu.provides.dbEu })` is a second copy of `reports`, named `reports#eu`: its own
infra units (`reports#eu/store`), usecases, services and entrypoints, publishing under `reports#eu.<key>`. Two copies
mount side by side, next to the original or not. A child feature is re-derived under the copy (`reports#eu.audit`);
a child need on the same handle follows the rebind. Adapters (schedule, queue, http, journal) register an instance's
jobs, locks, routes and effects under instance-qualified names; a plain feature's names stay byte-identical, so nothing
live changes. Evidence: `src/tests/define-feature.instance.test.ts` (types and runtime), adapter tests with two
instances, `typecheck-budget.test.ts` still green, every doc example compiling.

## Founder decisions (2026-10-16)

- **Name**: `<feature>#<instance>` — mirrors `Token.instance` (`arki.db#replica`). `.` stays nesting, `/` infra units.
- **Needs**: rebound in `instance(name, rebind)`; a rebound alias takes any handle of the same service type.
- **Provides**: an instance publishes qualified keys (`reports#eu.summary`), like a nested feature; consumers use
  `copy.provides.summary`. The original keeps bare keys.
- **Scope**: core + rpc + the four adapters in this plan.

Decided the same day: (a) http routes of an instance mount under `/<instance>` by default, `instancePath(instance,
path)` on `http()` changes the shape; (b) each instance gets its own schedule lock by default (a custom `lock.key`
string still serializes copies on purpose); (c) object-form `feature()` router fragments of an instance are keyed
`<mount>#<instance>`.

## Probe result (sandbox copy of HEAD, 2026-10-16)

Script `p7-instance.py` (scratchpad) applies 17 exact-string edits to `define-feature.ts` and one to
`plugin-contract.ts`; a 5-test file passes at runtime and under `tsc`; the full dot suite stays green (358 tests; the
two sandbox-only failures are `cli/new.test.ts` reading `packages/env`, absent from the copy). Instantiations for the
budget generator: 50 features 338,729 → 333,948; 100 features 936,129 → 926,548. Findings that shape the tasks:

1. The name is a literal type `TName` feeding every key type (`${TName}.usecases`, `feature.${TName}`,
   `${TName}/${plugin}`), and `DefinedFeature<TName, N, I, C, U, P, E>` derives all of them from its arguments. So
   `instance()` returns `DefinedFeature<`${TName}#${I}`, RebindNeeds<N, R>, I, InstanceChildren<…>, U, P, E>` and
   the whole type re-derives; the runtime re-runs `compile` on a renamed state. No rename-after-compile.
2. Children are compiled features. A phantom `[FeatureParamsTag]?: FeatureParams<…>` on `DefinedFeature` lets
   `InstanceOfChild` read a child's seven type arguments back and re-derive it as `reports#eu.audit`; at runtime an
   internal `[REPARENT](name, follow)` method recompiles each child under the new parent.
3. A child need follows the rebind by **handle identity** (`SameBound`: same provider and key; anonymous witnesses
   never match), both in types (`RebindFollowed`) and at runtime (`followRebind`, lazy forms included).
4. `WireNeeds` inferred the wire key through `Token<unknown, infer WK>`. A `Handle` carries `K` in `key`, `lazy.key`
   and `instance()`'s `${K}#${N}`, so a key holding `#` split into two candidates (`'reports' | 'reports#eu.repos'`).
   Inferring from `{ readonly key: infer WK }` alone fixes it (`WireNeeds`, `WireKeyOfNeed`) and is cheaper.
5. `.usecases()` closed over `state.name` for the trace span. The factories are now stored raw and wrapped in
   `compile`, so an instance traces as `feature.reports#eu.<usecase>`.
6. `mountFeatures` kept one owner per raw infra handle; a feature and its instances share the same infra plugin
   objects, so the map is now handle → set of owners.
7. `routerFor` finds a feature by contract identity and wants exactly one owner per app-contract key. The root copy's
   rpc entrypoint gets its own `contract` and `router` records (shallow; procedures shared); children keep theirs, since
   a parent's router holds its children's routers by identity. The app contract mounts `eu.contract` and `us.contract`.
8. Adapters key registrations by author-written names with no feature component (schedule `def.name`, queue
   `_internal.name`, journal effect/tap names, http `METHOD path`). Qualifying only when `instanceOf(f.name)` is set
   leaves every live name (avocabo's 30 schedules and pg advisory lock hashes, novelette's four BullMQ queues)
   unchanged.

## Phase 0 — Core (`packages/dot`)

**Modify** `src/define-feature.ts` (the probe's pairs, re-anchored on the working tree):

- Types: `Instanced<TName>`; `PublishKey` qualifies for `Nested | Instanced`; `FeatureParamsTag` + exported
  `FeatureParams`; exported `RebindOf<N>`, `RebindNeeds<N, R>`, `InstanceChildren<C, From, To, N, R>`; private
  `SameBound`, `FollowRebind`, `AsWitness`, `RebindFollowed`, `Reparent`, `InstanceOfChild`, `InstanceNameGuard`
  (one plain segment: no `.`, `/`, `#`), `FeatureNameGuard` (`defineFeature('a#b')` refused with a `DOT:` label).
  `DefinedFeature` gains the phantom tag and `instance<const TInstance, const R extends RebindOf<N> = EmptyShape>(name,
rebind?)`. `WireKeyOfNeed` infers from `key`.
- Runtime: `FeatureState.usecases` holds the raw factory record, traced in `compile`; `publishKey` qualifies for
  `nested || instanced`; `handlesOf(state, infra)` extracted from `stage`; `reparent(name, follow, root)` inside
  `compile`, exposed as `instance()` (validates the segment and the rebound aliases, builds the handle → handle map from
  `canonical(own)`) and as `[REPARENT]` for children; `followRebind`; `ownContract(entrypoints)` for the root copy;
  `defineFeature` throws on `#`; `mountFeatures` owners as a set.
- **Add** `export function instanceOf(name: string): string | undefined` (`'reports#eu'` → `'eu'`, `'reports#eu.audit'`
  → `'eu'`, `'reports'` → `undefined`) next to `parentOf`; adapters and `dot explain` read it.

**Modify** `src/plugin-contract.ts`: `WireNeeds` infers the wire key from `{ readonly key: infer WK }`.

**Modify** `src/feature.ts`: re-export `FeatureParams`, `RebindOf`, `RebindNeeds`, `InstanceChildren` (type block at
`:60-104`) and `instanceOf` (value block at `:59`).

**Add** `src/tests/define-feature.instance.test.ts` (the probe's five tests) plus: `instanceOf` cases; an instance's
unit `actions` ids start with `reports#eu.`; a lazy child need (`db.lazy`) follows the rebind to the new lazy form;
`renderExplain` of an app with two copies lists `reports#eu` and `reports#us` units; `override()` on an instance keeps
the instance name.

**Verify**: `turbo typecheck test --filter=@arki/dot` green, `typecheck-budget` within its ceilings, `bun run build &&
bun run test:docs` 0 failures.

### Phase 0 result (2026-10-16) — DONE

Applied by `p7-instance.py` (17 + 1 edits to `define-feature.ts`, 1 to `plugin-contract.ts`, 4 to `feature.ts`), plus
`src/tests/define-feature.instance.test.ts` (8 tests: two copies on two databases; original + copy, original twice
refused; nested child re-derived with its need following; lazy child need follows to the new lazy form; own rpc
contract per copy; `override()` keeps the instance name and `dot explain` lists both copies; `instanceOf`; the four
guards). `tsc` clean, dot suite 364/364, `typecheck-budget` within its ceilings (50 features 333,948; 100 features
926,548 instantiations — below HEAD). Changeset `dot-feature-instance.md`. Action ids of an instance's rpc procedures
are `reports#eu.<path>` by construction (`actionsOf(state.name, …)` runs in `compile`), not pinned by a test.

## Phase 1 — Object form `feature(name, {...})`

**Modify** `src/feature.ts`: the `Feature<TName, TNeeds, TProvides, TUse, TRouter, TRepos>` value gains
`instance(name, rebind?)` returning `Feature<`${TName}#${I}`, RebindNeeds<TNeeds, R>, …>`; `handles` are rebuilt for
the new name; `plug()` publishes `${name}.${key}` when `instanceOf(name)` is set and `PluginOf<F>` types the keys the
same way (`F['name'] extends `${string}#${string}`?`${F['name']}.${K}` : K`); router fragments keyed
`<mount>#<instance>` (decision c). `feature('a#b', …)` refused like `defineFeature`.

**Add** tests in `src/tests/feature.test.ts`: two instances mount; keys qualified; rebind typed; slices under
`feature.<name>#<instance>`.

## Phase 2 — Adapters qualify by instance

Rule, in each adapter: `const instance = instanceOf(f.name); const qualify = (name: string) => instance === undefined
? name : `${name}#${instance}``. A plain feature's names do not change.

- **`packages/schedule/src/dot.ts`**: `collectFeatureSchedules` (`:476-492`) and the pre-boot manifest (`:568`) qualify
  `def.name`; the default lock key (`:307-308`) and the action id `${name}.fire` (`:217`, `:584`) follow from it.
  Tests in `src/feature-schedules.test.ts`: two instances → two jobs, two lock keys, `trigger('send-digest#eu')`.
- **`packages/queue/src/dot.ts` + `create-queue.ts`**: qualify `_internal.name` where the registry is built
  (`:183-207`) so queue, worker, `registeredJobs`, scheduler id `schedule:<name>` and outbox rows all carry the qualified
  name; producers obtained through the feature's services use the same registry entry. Read `:139` (producer actions)
  and `outbox/registry.ts:57-68` first: the outbox resolves jobs by persisted name, so an instance's rows carry the
  qualified name. Tests in `src/dot.spec.ts`.
- **`packages/http/src/dot.ts`**: `featureRoutes` (`:168-181`) mounts an instance's bundle under
  `instancePath(instance, path)`, default `/${instance}${path}`; `HttpOptions.instancePath` overrides (decision a).
  The duplicate-route check in `engine.ts` is unchanged and now passes for two instances. Tests in
  `src/tests/dot.test.ts`.
- **`packages/journal/src/dot.ts`**: `declaredBy` (`:366-375`) and `sliceServices` (`:514`) qualify effect and tap names;
  the uniqueness check (`:346-347`) and action id `${effect.name}.run` (`:99`) follow. Tests next to the existing ones.
- rpc: nothing — Phase 0 gives each copy its contract; the app contract mounts each under its own key.

Each adapter: a changeset `minor` (new behavior for instances, nothing changes for plain features).

## Phase 3 — Docs and release

- `README.md`: a "Two copies of a feature" paragraph in the composition section (instance, rebind, qualified keys,
  app contract with `eu.contract`/`us.contract`); the `rename()` paragraph points to it.
- `docs/composition-doctrine.md`: instances vs nesting vs `rename()` — when each.
- `docs/plugin-authoring.md`: rebind semantics (same service type, any provider; children follow by identity).
- `docs/adapter-authoring.md`: "qualify by instance" with `instanceOf`; plain names never change.
- `docs/upgrade-guide.md`: new API; `#` reserved in feature names; `WireNeeds` key-only inference (a need on a handle
  whose key holds `#` now has one wire key).
- Changesets: `dot-feature-instance.md` (`@arki/dot` minor), one per adapter.
- Template sync: no template file declares a feature instance; nothing to mirror.

## Self-check

| Promise                                                                                | Evidence                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Two copies mount side by side, each on its own database                                | instance test 1                                                                 |
| Original + copy together; original twice still refused                                 | instance test 2 (type + runtime)                                                |
| Child re-derived; child need follows by identity (eager and lazy)                      | instance test 3 + lazy case                                                     |
| Own rpc contract per copy; `routerFor` mounts both                                     | instance test 4                                                                 |
| Guards: non-need rebind, wrong type, bad segment, `#` in a name                        | instance test 5                                                                 |
| Adapters: two instances → distinct jobs, locks, routes, effects; plain names unchanged | Phase 2 tests + a grep of the schedule/queue test snapshots for unchanged names |
| No type-cost regression                                                                | `typecheck-budget.test.ts`                                                      |
| Docs compile                                                                           | `test:docs`                                                                     |
