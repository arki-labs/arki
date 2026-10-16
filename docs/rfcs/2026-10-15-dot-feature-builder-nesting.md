# RFC: Dot feature builder — nested features, and infra that receives the feature's needs

- **Status**: Accepted (2026-10-16). Implemented in `packages/dot` (`src/define-feature.ts`, `src/define-app.ts`, `src/orpc.ts`), `packages/db/src/dot.ts`, `packages/journal/src/dot.ts`, `packages/schedule/src/dot.ts`, `tooling/eslint/feature-layers.js`; first real nested feature in Avocabo (`content-deduplication.summaries`).
- **Authors**: Fable (design, Revisions 0–3 and the infra-needs note), Astra (review and two confirmation passes), founder (decisions).
- **Extends**: `2026-10-15-dot-feature-builder.md` (the chain, layers, contract-first) and `2026-10-15-dot-feature-builder-cron.md`.
- **Sources**: the design files were in the session scratchpad (`fable-nesting.md` Revisions 0–3, `fable-infra-deps.md`, `astra-nesting-review.md`, `astra-nesting-confirm.md`, `astra-nesting-confirm2.md`, the `probe/nesting-fable` and `probe/infra-deps-fable` probes). This file keeps what outlives them.

## The idea in one line

A feature may own smaller features. A child is a finished feature of its own — same chain, same folders — named by its path (`digest.compile`), private to its parent's scope, and mounted by the parent, which hands it what it needs by identity. Infra plugins stop naming global handles: a feature declares every outside thing once in `.needs()`, and `.infra()` binds its plugins to those needs.

## Founder decisions (2026-10-16)

1. **Children are declared in the chain**: `defineFeature('digest').needs({…}).infra(…).features(compile, deliver).usecases(…)`. A child lives in `features/<parent>/features/<child>/` with the same four folders and `feature.ts`. A child's name is its path (`digest.compile`); `.features()` refuses any other name, and a duplicate.
2. **Visibility by scope, read from handle metadata only.** Every minted handle carries `scope` (the feature inside which it may be needed; `undefined` = public) and `internal` (a feature's own `usecases`/`services`/slice: nothing may need it). A child's public provides are scoped to the parent (`digest.compile.ranker`); the parent re-exports what should be public under its own key. Lazy forms carry the same metadata. Unit handles (`plugins()[i].provides`) carry it too, so the kernel units are not a back door.
3. **Remap by identity, assembly validates the owner.** A child names the parent's raw infra handle (`.needs({ repos: store.provides.repos })`); `.features()` rewrites that need to the parent's qualified key (`digest.repos`) only when the witness *is* one of the parent's raw handles, keeping the original under `origin`. `mountFeatures` (run by `defineApp().features()`) checks `origin ?? witness` against the ownership map and refuses an outsider or a cousin naming a store it does not own (`FEATURE_E005`).
4. **No ambient transaction.** `entrypointOnly(handle)` in `.needs()`: entrypoints see it and open the transaction; usecases never see it (`Deps` maps it away, the runtime builds usecases without it) and take `tx` as a parameter; repositories reach a transaction only through `repos.withTx(tx)`. `@arki/db/dot` adds `txRepos(factories)`, whose published `repos` has `withTx(tx)` and nothing else.
5. **Adapters read each node once.** `defineApp().features()` stores one normalized node list (`allFeatures`); drivers and driven adapters read a node's OWN units (`ownUnits`), never a descendant's. `@arki/journal`'s `declaredBy` changes one loop; `@arki/schedule` walks `.features()` for names (`ScheduleNameOf`, `composeSchedules`).
6. **One request bag key per feature.** The feature unit publishes `<name>.services` (needs + infra + children + usecases, `$`-prefixed kernel keys dropped); `bind(core)` reads that one key. A gateway needs `requestServices(features)`: the top-level features' public handles plus every node's `<name>.services`, published public because serving requests is the assembly's job.
7. **`rpc()` mounts a declared child's router once**, at the path the parent's contract gives it (`compile: () => compile.router` in the parent's `entrypoints/procedures.ts`); an inline contract group is still a group. A child router mounted under a feature that did not declare the child is a compile error.
8. **Tests at depth**: `override('compile.ranker')` by path; `fake(handle, value)` works at any depth; `dot explain` draws the tree as named units; shutdown runs in reverse boot order (parent's infra → children → parent, reversed).
9. **Infra receives the feature's needs — by binding, not by hand.** An infra plugin declares its needs unbound (`service<Db>()`). `.infra()` binds each alias to a sibling's key first, then to the feature's need of the same alias. An alias no sibling and no need satisfies, or one of another type, is a compile error (`UnsatisfiedInfraNeeds`) and a define-time refusal ("needs `db`, which the feature does not declare" / "binds `db` to a handle other than the feature's"). A plugin bound to the *same* handle is tolerated, so a sweep can go file by file. `.needs()` takes a record of aliases only — a bare handle is refused (`NotAHandle`). `repos(factories)` and `advisoryLocks(options)` drop the handle parameter.
10. **Lint holds the shape, structurally.** `features/<a>/features/<b>/` is a root of its own; every layer rule applies there first. Across roots a RUNTIME import may reach another feature's `feature.ts`, its contract (`entrypoints/rpc.ts`) and `model/**` only — plus an ANCESTOR's `infra/**` for a nested child (`feature-boundaries`). `infra/` makes no runtime import of the app's `db`/`kv` modules, any `feature.ts`, `usecases/` or `entrypoints/` (`infra-runtime-imports`). `import type` is always fine. A parent's contract may import its children's contracts.
11. **Names (Rule 6)**: `<feature>Deps`, `<feature>Logic`, `rpcImplementer`, `<feature>RpcContract`, `<feature>Procedures`, `<feature>Schedules`, `<feature>CronSpecs`; Dot internals `ScopedHandle`, `UnsatisfiedInfraNeeds`, `NotAHandle`, `sameHandle`, `ownUnits`, `allFeatures`, `mountFeatures`, `requestServices`.

## Revision 3 — the design that shipped (concise copy)

### 1. Unit handles keep ownership

The handles a unit publishes are minted with the same metadata as the feature's own: public provides scoped to the parent; `<name>.usecases`, `<name>.services`, `feature.<name>` internal; a qualified infra unit's handles scoped to the feature. Types: `FeatureUnit` and `QualifiedPlugin` intersect `Plugin<…>` with a `provides: UnitHandles<…>` / `InfraUnitHandles<…>` record, so `plugins()[i].provides[k]` is a `ScopedHandle` and both guards (`InternalNeeds`, `OutOfScope`) see it.

### 2. Remap by handle identity; assembly validates the original owner

A key-based remap bound a child's `repos` to whichever store the mounting feature had. The fix: `.features()` remaps a child need only when the witness *is* one of this feature's raw infra handles (object identity, lazy form included); the remapped handle keeps the original under `origin`; `mountFeatures` checks `origin ?? witness` against the ownership map. **Known gap, stated**: the *type-level* remap is key-based, so `reports.features(x)` (where `x` names *digest's* store) compiles — the runtime refuses it at assembly, before boot. A typed version needs `plugin()` to retain witnesses.

### 3. Entrypoint-only needs; closed transactions

`needs({ db: entrypointOnly(database.provides.db), repos })`: the flag (kept on `.lazy`, with `origin`) removes the need from the usecases' deps while entrypoints keep it. A usecase asking for `db` is the existing "asks for a dep the feature does not provide" error. Entrypoints open the transaction, usecases take `tx`, repos exist only as `withTx(tx)`.

### 4. Adapters: own units, read once

`feature.plugins()` is recursive, so a journal adapter scanning it registered a child's projection twice (once for the parent, once for the child node) and threw "duplicate projection name". `ownUnits(node)` (units named `<name>` or `<name>/…`) reads each node's own declarations once. `defineApp().features()` stores the normalized node list for both binding paths.

### 5. Boundary lint: structural, layers first, every root

Roots are found from path segments (`features/<name>`), recursively. At every root, layer rules apply first, whatever root the target is in; then the boundary exceptions. Imports are parsed with the TypeScript parser: static imports, re-exports, dynamic `import()` with a literal or a plain template literal; `import type`, inline `type` specifiers and `typeof import('…')` are type-only. Legacy shapes (an importer outside a layer folder, a target outside one) are not checked: they are waiting to convert.

### 6. One `entrypoints/procedures.ts` per feature

```ts
// digest/entrypoints/procedures.ts
export const digestProcedures = {
  run: (o: typeof rpcImplementer) =>
    o.run.handler(({ context, input }) => context.db.transaction(tx => context.usecases.run(tx, input.userId, input.items))),
  compile: () => compile.router,
  deliver: () => deliver.router,
};
// digest/feature.ts
const digestDeps = defineFeature('digest').needs({ db: entrypointOnly(database.provides.db) }).infra(store).features(compile, deliver);
export type DigestDeps = DepsOf<typeof digestDeps>;
export const digestLogic = digestDeps.usecases({ run });
export const rpcImplementer = implement(digestRpcContract).$context<RequestContext>().use(bind(digestLogic));
export const digest = digestLogic.provides({ … }).entrypoints(rpc(digestRpcContract, rpcImplementer, digestProcedures), digestSchedules);
```

### 7. Infra receives the feature's needs

```ts
// infra/store.ts — imports no global handle
export const store = repos({ dedup: createContentDeduplicationRepository }); // needs: { db: service<DatabaseOf<F>>() }

// feature.ts
const dedupDeps = defineFeature('content-deduplication')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(store, embedder, vectors, advisoryLocks({ namespace: APP_KEY }))
  .features(summaries);
```

Rule: every need alias of an infra plugin is a sibling key or a feature need alias. Nothing else. `.needs()` is the complete outside list, checked by the type guard and again at define time. `dot explain` gains one true edge (the feature unit needs `db`). `fake(database.provides.db, x)` reaches every infra plugin through the one need.

## Rejected alternatives

- **Astra's scope callback** (`scope.defineFeature(...)` / a child declared inside a parent callback, so a plugin learns its owner at declaration). Rejected by the founder: child files must stay plain — a child is an ordinary feature file importable on its own. The identity remap plus the assembly check give the same refusal at define time and before boot, with one known gap (typed remap) stated above.
- **Ambient transaction** (a request-scoped `tx` every usecase reads implicitly). Rejected: hidden state, no type telling which usecase runs inside which transaction, and a nested `db.transaction` from a usecase becomes possible again. Explicit `tx` as the first parameter, opened by the entrypoint; `entrypointOnly(db)` makes the other path a compile error.
- **Callback form for infra deps** (`.infra(({ db }) => [store(db), …])`). Rejected: `db` is still named twice (needs + argument); `infra/store.ts` becomes a factory whose handle type must be restated; the built store lives inside the chain, so a child can no longer import `store.provides.repos` and the identity remap has nothing to match; two `.infra` forms. Binding by alias keeps one form and one door.
- **Keep infra as is, lint only.** Rejected: a lint sees imports, not types or identity.
- **Key-based remap of child needs.** Rejected after Astra's reproduction (a sibling feature's child naming another feature's store was silently rebound): identity with provenance instead.
- **Reading adapter declarations from `feature.plugins()`.** Rejected: recursive, so nested declarations register twice; `ownUnits` over the one node list instead.

## Breaking changes (pre-1.0, minor changesets)

- `@arki/dot`: `.needs()` refuses a bare handle; feature services are published under one bag key `<name>.services`, read by `needsMiddleware`/`bind`; unit handles carry ownership (a gateway spreads `requestServices(features)`, not `plugins()` provides).
- `@arki/db`: `repos(factories)`, `advisoryLocks(options)` — the feature declares `db` in `.needs()`; new `txRepos(factories)`.
- `@arki/journal`: `declaredBy` reads `ownUnits` (behaviour change only for nested features).
- `@arki/schedule`: `ScheduleNameOf`/`composeSchedules`/`cronRouterFor` see nested features' schedules.

## What stays unproven / known gaps

- The type-level child remap is key-based (a foreign store's child compiles; runtime refuses at assembly).
- The typed infra-entry guard checks by wire key and type; a plugin bound to the right key but a different handle object of the same type is caught at runtime only.
- The boundary lint reads paths, not types: a feature that re-exports another feature's internals through its own `feature.ts` passes the lint (and is refused by the scope guard at `.needs()`).
