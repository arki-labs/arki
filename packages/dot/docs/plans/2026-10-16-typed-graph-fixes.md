# Plan — Typed graph fixes 1–8 (round 9)

Source: `docs/arki/research/09-di-typing/synthesis.md` § 4, gaps 1–8. Founder excluded #9 (request scope) and #10
(feature instances). Probe seeds live in
`/private/tmp/claude-501/-Users-afurculita-Developer-workspace/58cb461e-b815-4666-976f-f7be5097a3cf/scratchpad/di-probes/dot/`
(`06`…`09`, `02`, `03`, `05`, `gen-scale.mjs`); each one becomes a test in `packages/dot` as listed per task.

## Goal

Dot's types catch everything its runtime catches today, with no hand-written service type anywhere on the
feature path, and the app-level check stays near-linear in the number of features.

## Success evidence

1. `turbo typecheck test --filter=@arki/dot` green, with these new tests red on today's `master` (each task names
   its test; run the test file alone first to see it fail).
2. `turbo typecheck --filter=@avocabo/backend --filter=@arki/db --filter=@arki/journal --filter=@arki/auth --filter=@arki/schedule --filter=@arki/lock` green.
3. `grep -rn "service<" apps/avocabo/backend/src` → zero hits.
4. Instantiations for the generated 50-feature app ≤ 250 000 and for 100 features ≤ 600 000 (today 745 106 and
   2 581 506), asserted by a test.
5. A changeset `minor` for `@arki/dot` and `@arki/db`.

## Assumptions

- `@arki/*` is below 1.0: no backward compatibility; every call site is updated in the same change.
- Plugin names are unique per app (runtime `ARKI_DOT_E011`), so **plugin name + publish key is the provider identity**
  the types can use. True per-call-site identity is not expressible in TypeScript (no declaration-site `unique symbol`
  from a call). Residual hole after this plan: two plugins with the same name _and_ key _and_ shape (library plugins
  like `repos()` are all named `repos`). The runtime raw-handle check (`define-feature.ts:880-893`) still catches it;
  Phase 0 records this residual in `composition-doctrine.md`.
- Declaration order stays boot order (`docs/principles.md:85`). No sorting.
- Tests are vitest; type assertions use `expectTypeOf` and `// @ts-expect-error -- reason` (existing pattern,
  `src/tests/define-feature.test.ts:218-252`).

## Chosen architecture (what changes in the type model)

```text
today:  Plugin<TNeeds(wire key -> value), TProvides>          witness identity erased
after:  Plugin<TNeeds, TProvides, TShape(alias -> witness)>   + handles carry the plugin's name as a literal
        Handle<T, K, O = plugin name literal>
```

- `plugin<const TName extends string, TShape, TProvides>({ name: TName, … })` returns
  `Plugin<WireNeeds<TShape>, TProvides, TShape> & { provides: Handles<TProvides, TName> }`.
- A third phantom carrier `[ProviderIdentitySym]?: TShape` on `Plugin` (default `NeedsShape`) and an extractor
  `PluginProviderIdentities<P>`. **Names confirmed by the founder 2026-10-16.**
- Remap and identity checks read witnesses (`provider` + `key` literals), exactly where the runtime reads handle
  identity (`remapNeeds`, `define-feature.ts:906-925`; `sameHandle`, `:1273-1278`).
- Infra plugins may bind a need to a handle directly (`needs: { db: database.provides.db }`); the runtime already
  allows it when it is the feature's own handle (`:1273` `sameHandle`). Unbound `service<T>()` stays legal for library
  plugins that infer `T` from their factories (`repos()`).

---

## Phase 0 — Design probe for #1 / #4 / #6 (identity-carrying witnesses)

Do this on the working tree, commit only if green. Nothing else starts until this phase has a verdict.

**Modify** `packages/dot/src/plugin-contract.ts`

- `Plugin<TNeeds, TProvides, TShape extends NeedsShape = NeedsShape>`; add `readonly [ProviderIdentitySym]?: TShape` next to
  `[NeedsSym]` (line 486).
- `plugin()` (line 526): add `const TName extends string` from `def.name`; return type
  `Plugin<WireNeeds<TShape>, TProvides, TShape> & { readonly provides: Handles<TProvides, TName> }`.
- `rename()` (line 587): add `const NewName extends string = …` from `newName`; return keeps `TShape`; `provides`
  typed `Handles<RenamedProvides<TP, M>, NewName>` (when `newName` is omitted the provider literal stays `P`'s).
- Export `PluginProviderIdentities<P> = P extends Plugin<ServiceRecord, ServiceRecord, infer W> ? W : NeedsShape`.

**Modify** `packages/dot/src/define-feature.ts`

- `RemappedUnit` (247-251): remap alias `K` to `Qualify<TName, K>` **only when**
  `PluginProviderIdentities<P>[K] extends { readonly provider: InfraNames<I>; readonly key: K }` where
  `InfraNames<I> = I[number]['provides'][keyof …]['provider']` (the parent's infra plugin names). Otherwise keep the
  witness's wire key (`WireKeyOfNeed`). `ChildUnits`/`UnitsOf` pass `I` through (new type parameter).
- `ResolvedInfraNeed` (546-550): when the infra witness `PluginProviderIdentities<I[J]>[K]` has a `key`, it is satisfied only
  if the feature's `N[K]` witness has the same `provider` and `key` literals (strip `lazy`/`entrypointOnly` wrappers:
  compare the two properties only). Otherwise today's shape check. Label unchanged
  (`'DOT: an infra plugin needs a service the feature does not declare in .needs() (or declares with another type)'`).
- `QualifiedPlugin` (392-405): carry `TShape` through.

**Create** `packages/dot/src/tests/define-feature.identity.test.ts` (from probes 07 and 09)

```ts
// A1: child needs the global `database.provides.db`; parent owns a same-shaped private infra `db`.
// Today: zero diagnostics, boot throws ARKI_DOT_E012. After: the app call fails to compile.
// @ts-expect-error -- `db` of "parent.child" is the global handle; nothing in [parent] provides it
defineApp('hole').features([parent]);
defineApp('ok').infra(database).features([parent]); // compiles
// A2: infra plugin bound to dbB; feature declares dbA.
// @ts-expect-error -- store binds `db` to "dbB", the feature's `db` is "dbA"
defineFeature('f').needs({ db: dbA.provides.db }).infra(storeBoundToB);
defineFeature('g').needs({ db: dbB.provides.db }).infra(storeBoundToB); // compiles
```

Plus `it` blocks that boot the compiling cases with `bootTestApp` so the runtime agrees.

**Create** `packages/dot/src/tests/plugin-handles.identity.test.ts`:
`expectTypeOf(database.provides.db.provider).toEqualTypeOf<'database'>()`; `rename(p, { db: 'replica' }, 'replica').provides.replica.provider` is `'replica'`.

**Probe target for #4** (type-only, in the same test): a plugin with `needs: { db: database.provides.db, clusters: dedup.provides.clusterDetails }` and no `service<T>()` has `CtxOf` deps typed from the handles, and a feature that declares both handles accepts it in `.infra()`.

**Verify**: `turbo test --filter=@arki/dot -- define-feature.identity plugin-handles.identity`; then the full
`turbo typecheck test --filter=@arki/dot` and the dependents list from Success evidence 2 (they must still compile
unchanged — `Plugin<N, P>` keeps two-parameter form via the default).

**Verdict rule**: pass = all three (`@ts-expect-error` lines error, positive lines compile, dependents green).
**Fallback if it fails**: ship Phase 2–6 unchanged; for #1/#6 add runtime regression tests only
(`define-feature.nesting.test.ts`: boot of the A1 graph throws `E012`; `define-feature.infra-needs.test.ts`: `E026`),
and add to `composition-doctrine.md` a "known type holes" section naming A1/A2 with the probe files. #4 then falls
back to `transactions(database.provides.db)` as a _runtime-bound_ handle whose type is `Provided<typeof handle>` —
that part does not depend on identity in types.

---

### Phase 0 result (2026-10-16) — PASS

- Shape: `Plugin<TNeeds, TProvides, TShape = NeedsShape, TOwner extends string = string>`; `provides: Handles<TProvides, TOwner>`
  (no intersection — `toEqualTypeOf` stays exact). `plugin()` infers `TName` last (explicit `plugin<Shape, Provides>()` callers
  keep compiling with `TOwner = string`). `rename()` is generic over the plugin (`PluginOwner<P>` default for the new name).
- Remap and identity read `PluginProviderIdentities<P>`; `OwnedShape<N, S>` mirrors `qualifyInfra`'s `declared[alias]`
  substitution; `SameHandle` mirrors `sameHandle`. Unknown shape or erased provider (`string`) → the old wire-key rules.
- Bonus fix found by the #4 probe: the infra guard resolved a plugin's need by WIRE key while the runtime resolves it by
  ALIAS, so a bound need whose alias ≠ key (`clusters: dedup.provides.clusterDetails`) was a compile error the runtime
  accepted. Known shapes are now checked by alias (`UnsatisfiedInfraAliases`); erased plugins keep the wire-key check.
- Evidence: `define-feature.identity.test.ts` (A1, A2, anonymous-vs-bound) and `plugin-handles.identity.test.ts` (provider
  literals, erased `Plugin<N, P>`, #4 probe); `define-feature.infra-needs.test.ts:150` now needs `@ts-expect-error` (A2 was
  runtime-only). `@arki/dot`: tsc 0, eslint 0, 351/351. `turbo typecheck --filter='...@arki/dot'`: 95/104; the 9 failures
  (`toSorted`/`URL.canParse` lib targets, `Instant` vs `Date`, missing kapodopera exports, `Backoff`) are pre-existing and
  name no dot symbol.
- Implication for Phase 1 (#4): library plugins annotated `Plugin<EmptyShape, X>` (`@arki/db` `database()`, kv, env, http,
  queue, journal, schedule, auth, resilience) erase their name, so their handles carry `provider: string` and the identity
  checks fall back to wire keys around them. Task 1.1 should also return the inferred `plugin()` type (or
  `Plugin<…, …, …, 'database'>`) so the A1/A2 guards bite for app code that nests library infra.

## Phase 1 — Fixes #1, #6, #4 for real (after Phase 0 passes)

### Task 1.1 — Library infra takes a handle instead of a type argument (#4)

**Modify** `packages/db/src/dot.ts:409-420`:

```ts
export function transactions<H extends Handle<Transactable<unknown>, string, string>>(db: H) {
  type Tx = TxOf<Provided<H>>;
  return plugin({
    name: 'transactions',
    needs: { db },
    provides: {
      transaction:
        ({ db }): OpenTransaction<Tx> =>
        fn =>
          db.transaction(fn),
    },
  });
}
```

`repos()`/`txRepos()` (335-370) stay unbound: `service<DatabaseOf<F>>()` is inferred from the repo factories, not
written by the user. `db()` (236) stays. Update the JSDoc example at `:246` of the dist doc comment source.

**Modify call site** `apps/avocabo/backend/src/features/daily-digest/feature.ts:79`: `transactions<Db>()` →
`transactions(database.provides.db)`. (Found with `grep -rn "transactions<" apps packages turbo --include='*.ts' | grep -v dist`.)

### Task 1.2 — App-local infra binds handles (#4)

**Modify** (found with `grep -rln "service<" apps/avocabo/backend/src`):

- `features/daily-digest/infra/extras.ts:18-25` → `needs: { db: database.provides.db, clusterDetails: contentDeduplication.provides.clusterDetails, syntheses: crossDocumentIntelligence.provides.digestSyntheses, episodeCards: podcastSupport.provides.episodeCards, videoCards: youtubeIntegration.provides.videoCards, copilotInsights: aiCopilot.provides.digestInsights }`; delete the `DigestExtrasDeps`-based witnesses; `DigestExtrasService` keeps its constructor type derived from `CtxOf<typeof extras.needs>` or the plugin's factory parameter (no separate interface).
- `features/semantic-search/infra/reconciler.ts:14` → `db: database.provides.db`.
- `features/workspaces/infra/registry.ts:72` → `db: database.provides.db` (check `Database` vs `Db`: if the registry needs the transaction-capable union, keep the need on the `db` handle and widen inside the service).
- `features/waitlist/infra/signup-limiter.ts:16` → `kv: cache.provides.kv` (confirm the handle name in `apps/avocabo/backend/src/kv.ts`).
- `features/newsletter-ingestion/features/reconciliation/infra/alert-dispatch.ts:182` → `outboundMail: outboundMail.provides.outboundMail` from `features/newsletter-ingestion/infra/outbound-mail.ts` (the parent `reconciliation/feature.ts:31` already needs that handle).

Edge: the feature's `.needs()` must declare the same handle (runtime `:1265` "needs alias which the feature does not
declare"); `entrypointOnly(...)` wrappers are fine (identity compares `provider` + `key`).

Library packages keep `service<T>()` (`packages/journal/src/dot.ts:401,513`, `packages/auth/src/dot.ts:18`,
`packages/schedule/src/dot.ts:13`): they are generic over the app's db. Not touched by this plan.

**Verify**: `turbo typecheck test --filter=@avocabo/backend --filter=@arki/db`; `grep -rn "service<" apps/avocabo/backend/src` → 0.

### Task 1.3 — Template sync

`grep -rn "service<\|transactions<\|testApp(" turbo/generators/templates` → no hits today. Re-run after Phase 1; if
still none, nothing to sync. Record the grep in the commit message.

---

## Phase 2 — Fix #2: inline `.usecases()` deps (independent of Phase 1)

**Modify** `packages/dot/src/define-feature.ts`

- Add `type UsecaseFactoriesOf<D> = Readonly<Record<string, (deps: D) => unknown>>`.
- `UsecasesStage.usecases` (653-655): `usecases<const F extends UsecaseFactoriesOf<CoreDeps<N, I, C>>>(factories: F & UsecaseGuard<CoreDeps<N, I, C>, F>)`.
  Keep `UsecaseFactories`/`Usecases<F>` (588-591) for the return type.
- **Keep the DOT label (founder decision 2026-10-16).** With only the constrained signature, a factory that asks for a
  missing dep fails the constraint first with `Property 'mailer' is missing in type 'Deps'` and the
  `'DOT: a usecase asks for a dep…'` label is never reached (probe 06 line 23). Add a second, fallback overload after
  the inferring one: `usecases<const F extends UsecaseFactories>(factories: F & UsecaseGuard<CoreDeps<N, I, C>, F>)`
  (today's signature). The first overload gives inline inference; the second is only chosen when the first fails, and
  its `UsecaseGuard` prints the label.
- **Probe first (needs probe):** extend probe 06 with the two overloads and check (a) inline `({ repos }) => …` still
  infers through overload 1, (b) the over-asking case's error text contains `DOT: a usecase asks for a dep` (TS prints
  the last overload's failure under "No overload matches this call"), (c) the Phase 5 generator at N=50 gains no more
  than 5% instantiations. If (b) fails, keep overload 1 only and report to the founder with the exact error text; do not
  ship a second overload that never shows the label.
- Behaviour: `({ repos }) => …` inline gets `CoreDeps`; `Pick<Deps, 'repos'>` annotations still fit (parameter
  contravariance). Existing tests at `define-feature.test.ts:246-251` must stay red lines.

**Create** in `packages/dot/src/tests/define-feature.test.ts` a test "infers inline usecase deps" (probe 06 →
`expectTypeOf(f.handles.usecases)…`, and a usecase body calling `repos.all()` with no annotation).

**Verify**: `turbo test --filter=@arki/dot -- define-feature`; `turbo typecheck --filter=@avocabo/backend` (all
avocabo usecases are annotated; they must keep compiling).

---

## Phase 3 — Fix #7: duplicate infra keys (independent)

**Modify** `packages/dot/src/define-feature.ts:542-570`: add
`type InfraDup<I, Seen = never>` folding over `I` like `SiblingDup` (`:312-318`) on `keyof PluginProvides<I[n]>`; add
to `InfraGuard` the branch `{ readonly 'DOT: two infra plugins provide the same key': InfraDup<I> }`.

**Create** test in `packages/dot/src/tests/define-feature.infra-needs.test.ts` (probe 08):
`// @ts-expect-error -- s1 and s2 both provide "repos"` on `defineFeature('f').infra(s1, s2)`; and an `expect(() => …).toThrow(/E027|collides/)` for the runtime pair.

**Verify**: `turbo test --filter=@arki/dot -- infra-needs`.

---

## Phase 4 — Fix #3 and #8: labels on the argument, typed `testApp`

### Task 4.1 — `.use()` / `.features()` / `boot()` guards move onto the argument (#3)

**Modify** `packages/dot/src/define-app.ts`

- `.features()` (325-328): `features<const TFeatures …>(features: TFeatures & ListGuard<UseAllGuard<TAvail, Extract<FeatureUnits<TFeatures>, readonly AnyPlugin[]>>>)` — same form as `.infra()` (315-318). Drop the rest `...guard`.
- `.use()` (297-300) and `.serve()` (261): `use<TNeeds, TProvides>(plugin: (Plugin<TNeeds, TProvides> | Driven<…>) & UseGuardOnArg<TAvail, TNeeds, TProvides>)` where `UseGuardOnArg` returns `unknown` when `UseGuard<…>` is `[]`, else `{ readonly 'DOT: this unit needs services that nothing before it provides…': NeedsError<…>[…] }` (reuse `NeedsError`/`CollisionError` 54-66). Delete the rest-tuple form of `UseGuard` once nothing uses it; keep `UseAllGuard` (used by `ListGuard`).
- `test-harness.ts:82-85,125`: `boot(this: TestPluginBootGuard<TRemaining> extends [] ? TestPluginBuilder<TRemaining, TServices> : { readonly 'DOT: provide these needs before boot()': keyof TRemaining })` — a `this` parameter puts the label in the TS2684 text. Same for `start`.

**Tests**: `src/tests/define-app.test.ts` already has `@ts-expect-error` lines for missing/collision (keep them);
add one assertion that the _argument type_ carries the label:
`expectTypeOf<Parameters<typeof builder.features>[0]>().toMatchTypeOf<{ readonly 'DOT: a unit in this list cannot be mounted at its position': unknown }>()` for a builder lacking a provider. Manual check recorded in the PR: run
`tsc --noEmit` on probe 02 (copied under `src/tests/fixtures/`) and paste the first error line — it must contain `DOT:`.

### Task 4.2 — `testApp` infers its services (#8)

**Modify** `packages/dot/src/test-harness.ts:53-62`:
`testApp<const TPlugins extends readonly AnyPlugin[]>(plugins: TPlugins & ListGuard<UseAllGuard<EmptyShape, TPlugins>>, options?): DotAppBuilder<UseAllAvail<EmptyShape, TPlugins>>`; `bootTestApp` likewise. `makeTestPluginBuilder` (166-200) builds through `defineApp(...).use()` with its existing erasure cast instead of `testApp<ServiceRecord>`.

**Call sites** (`grep -rln "testApp(\|bootTestApp(" apps packages turbo --include='*.ts' | grep -v node_modules`):
`src/tests/define-feature.test.ts`, `src/tests/define-app.test.ts`, `src/cli/tests/observability-probe.test.ts`,
`src/cli/tests/render-doctor.test.ts` — drop explicit `<TServices>` arguments; where a test passes a runtime-built
array, write it as a tuple literal.

**Verify**: `turbo typecheck test --filter=@arki/dot`.

---

## Phase 5 — Fix #5: near-linear app guard, with a budget test

**Modify** `packages/dot/src/define-app.ts:86-113` (`UseAllState`):

- Accumulate `Flat<TAvail & NormalizeProvides<TProvides>>` with `type Flat<T> = { readonly [K in keyof T]: T[K] }` so
  `TAvail` is one object type per step, never a nested intersection.
- Check keys before shapes: `[Exclude<keyof TNeeds, keyof TAvail>] extends [never]` first; only then
  `MismatchedKeys` over `keyof TAvail & keyof TNeeds`. Replace the `[TAvail] extends [TNeeds]` structural test
  (line 81) with these two.
- `FeatureUnits` (167) and `ListGuard` unchanged.

**Create** `packages/dot/bench/typecheck/gen-features.mjs` (from `gen-scale.mjs`, Dot section only; argument N;
writes `bench/typecheck/.generated/features-<N>.ts`; `.generated/` gitignored) and `bench/typecheck/tsconfig.json`
(extends the package tsconfig, `include: [".generated/*.ts"]`, `noEmit`).

**Create** `packages/dot/src/tests/typecheck-budget.test.ts`: runs `node bench/typecheck/gen-features.mjs 50` and `100`,
then `tsc -p bench/typecheck/tsconfig.json --noEmit --extendedDiagnostics`, parses `Instantiations:`, asserts
`≤ 250_000` at 50 and `≤ 600_000` at 100 (today 745 106 / 2 581 506 — the test is red on `master`). Counts, not
seconds, so it is stable on a busy machine. Exclude it from `test:runtimes` (it needs `tsc`).

**Verify**: the budget test; `turbo typecheck --filter=@avocabo/backend` (23 features) still green; record
`Instantiations` before/after in the changeset body.

---

## Phase 6 — Docs, changeset, self-check

**Modify** docs that show `service<T>()` for app infra (`grep -rn "service<" packages/dot/docs packages/dot/README.md packages/dot/llms.txt packages/db/README.md`):
show bound handles for app-local infra, keep `service<T>()` only in the library-plugin section; add the residual
identity note (Assumptions) to `composition-doctrine.md`; update `define-feature.ts` header comment (lines 19-21)
that says infra needs are always unbound.

**Create** `.changeset/dot-typed-graph-identity.md`: `'@arki/dot': minor`, `'@arki/db': minor`. Body: witness carrier
on `Plugin`, handles carry provider literal, `.features()`/`.use()` guards on the argument, `testApp` typed,
inline usecase inference, infra duplicate guard, app-guard flattening with the before/after instantiation counts,
`transactions(handle)` signature.

**Self-check before the final commit** (fail loud if any is missing):

- #1 → Phase 0/1 (`RemappedUnit`), test `define-feature.identity.test.ts`
- #2 → Phase 2, test in `define-feature.test.ts`
- #3 → Task 4.1, `define-app.test.ts` + `test-plugin.test.ts`
- #4 → Tasks 1.1/1.2, evidence `grep service< apps/avocabo/backend/src` = 0
- #5 → Phase 5, `typecheck-budget.test.ts`
- #6 → Phase 0/1 (`ResolvedInfraNeed`), same identity test
- #7 → Phase 3, `define-feature.infra-needs.test.ts`
- #8 → Task 4.2, callers updated
- Template grep (Task 1.3) recorded; changeset present; `turbo typecheck test --filter=@arki/dot` and the dependents list green.

## Founder decisions (2026-10-16)

1. Names: `ProviderIdentitySym` (symbol key) and `PluginProviderIdentities<P>` (extractor), replacing the proposed
   `WitnessSym` / `PluginWitnesses`.
2. The residual identity hole (same plugin name + key + shape) is accepted and documented in
   `composition-doctrine.md`; runtime E026 still catches it. `repos()` / `transactions()` do not take a name.
3. Keep the `'DOT: a usecase asks for a dep…'` label: Phase 2 adds a fallback overload, gated by its probe.
