# RFC: the usecase boundary in Dot

- Date: 2026-10-22
- Status: Proposed. Founder decisions D1–D9 below; D1 decided (`domainServices`), D9 decided (forbidden). Implementation started 2026-10-22; see `docs/plans/2026-10-22-dot-usecase-boundary.md`.
- Designer: Fable. Three brainstorm rounds, twelve agents (hexagonal, DDD, framework prior art, Dot type level, contrarian, cross-examination, unification, reader and lint, rename, private-usecase design, readability, cycle adversary). File references come from those passes on 2026-10-22; recheck them when a step starts.
- Supersedes one line of `2026-10-15-dot-feature-builder.md`: "Domain logic is a feature, even when it is small. No `domainUnit` constructor" (line 54). The founder reopened it on 2026-10-22.
- Companion: `.agents/skills/domain-driven-design/` (vocabulary and placement test). The skill describes today's rules; it changes when this RFC lands.

## 1. The shape in one sentence

**Everything that leaves a feature is a usecase, and everything a usecase is built from is declared above it in the chain, so a reader sees the whole feature in `feature.ts` and a cycle cannot be written.**

## 2. Why

A feature chain today: `needs → infra → features → usecases → provides → entrypoints`. Each step sees what is above it. Two things are missing, and one thing leaks.

**Missing: a home for a domain service.** Logic that two usecases share, or that needs a port to decide, has no slot. The survey of `apps/avocabo/backend/src/features/` (24 features) on 2026-10-22:

| Finding | Count | Where |
|---|---|---|
| Helper classes in `usecases/` that are not usecases (`*-service.ts`, `*-engine.ts`) | 38 across 25 backends | `feature.ts` never names them |
| Of those, with two or more consumers | about 11 | `tts-generation-service.ts` has three callers |
| Construction sites that build such a helper **on every call** | 13 of 25 | `auto-clustering/usecases/assign-new-items.ts:42`, `run-entity-resolve.ts` builds three per call |
| Feature-level `infra()` units that build a domain object, not an adapter | 11 of 40 | `daily-digest/infra/extras.ts`, `auto-clustering/infra/namer.ts` |
| Feature infra whose `needs` list other features' `provides` | at least 1 | `extras` needs five |

People use `infra` for domain objects because it is the only step built once per boot. Every mature framework surveyed (NestJS, Spring, Effect, Go wire and fx, awilix) makes lifecycle hooks opt-in per object; none has a slot defined by lifetime. The slot should be defined by **role and visibility**. Dot already supports a lifetime on a value through `resource()` in `provides` (`unit-contract.ts` `ProvidedValue`).

**Missing: an order that serves both real cases.** In `daily-digest`, `extras` must exist before the child `deliver`, which needs it (`features/deliver/feature.ts:30`). `firstDigest` needs the child's output `delivery.deliver` (`usecases/first-digest-fast-path-service.ts:48`), so it must come after the children. A fixed slot cannot serve both. A repeatable step on either side of `.features()` can.

**Leaking: the two exits.** `provides` and `entrypoints` see needs, infra, children and usecases (`CoreServices`, `define-feature.ts:118-123`). Measured use in all backends:

| Exit | Uses only usecases | Uses something else |
|---|---|---|
| `entrypoints` | 370 reads of `context.usecases` plus request keys | 2 (`highlights/entrypoints/idempotency.ts:21` reads `context.db`; one middleware value) |
| `provides` | 11 factories | 13 publish a repository slice via `reader(repos.x, [...])`; 5 re-publish an adapter handle (`vectorIndex`, `audioStorage`, `mailboxes`) |

A repository method published through `reader()` is not traced and not supervised. The same read through a usecase is both. So a cross-feature call such as `podcastSupport.provides.episodeCards.getEpisodesByContentItem` pays no toll, while a usecase call does.

**Two holes that exist today, verified with the repo's TypeScript 7.0.2 (adversary pass, scratch files under the session scratchpad `cyc/`):**

1. The deps object handed to usecase factories is one shared, unfrozen object (`prepareUsecases`, `define-feature.ts` ~1407). A factory can `Object.assign` itself onto it and an earlier factory's closure can read it at call time. It compiles with no casts. That is a cycle the types do not see.
2. No import-cycle lint runs in `tooling/`. Two usecase files can call each other through hoisted functions, skipping DI entirely.

**One lint drift.** `infra-runtime-imports` (`tooling/eslint/feature-layers.js:300-304`) bans only the unit's own or an ancestor's `feature.ts`. Its header says other features' `feature.ts` are fine. Nesting decision 10 (`2026-10-15-dot-feature-builder-nesting.md`) says infra makes no runtime import of any `feature.ts`. Running eslint on `daily-digest/infra/extras.ts` gives zero layer errors.

## 3. The pieces

| Piece | What it is | Sees | Seen by | Built | Span | Supervised |
|---|---|---|---|---|---|---|
| `needs` | handles borrowed from the app and other features | — | everything below | by its provider | — | — |
| `infra` | adapters this feature owns; hooks allowed | needs | domain services, children, usecases, entrypoint-only needs stay with entrypoints | once per boot | no | no |
| **`domainServices`** (D1) | domain services: plain factories `(deps: Pick<DomainDeps, …>) => value`; classes allowed; no hooks; lifetime only through `resource()` on the value | needs minus `entrypointOnly`, infra, earlier domainServices calls, children declared above it | later domainServices calls, children declared below it (by `domainService(fn)` handle), usecases | once per boot | child span if a function | **no** |
| `features` | sub-contexts | parent infra and domain services declared above, by handle | parent usecases, later siblings | once per boot | — | — |
| `usecases` | application services, one per intent | all of the above | provides, entrypoints | once per boot | yes | yes |
| `provides` | the driving port | **usecases only** (D7) | other features, parent | once per boot | — | — |
| `entrypoints` | driving adapters | **usecases, request keys, `entrypointOnly` needs** (D8) | the outside | per binding | — | — |

The one rule, for every step: **a step sees only what is written above it, never its peers.** That is what makes a cycle unwritable (§ 6).

## 4. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | **The step is `domainServices`.** Decided by the founder on 2026-10-22: `domain` alone suggests too much, and the kind is a domain service (Evans; the Onion "domain services" ring). One word in four places: step `.domainServices({ … })`, folder `domain-services/` (a sibling of `usecases/`, never inside it), deps type `DomainDeps`, child helper `domainService(fn)`, unit name `<feature>/domain-services`, role `'domain-service'` in `dot explain`. The noun stays **service**, as in `@arki/journal` and DDD. Rejected: `shared`, `private`, `internal` (visibility, not kind), `domain` (ambiguous next to `model/`), `services` (the kernel's request bag and a reserved alias, `define-feature.ts:85`), `domainUnits` (names the mechanism and promises the unit-literal shape; entries here are factories). The folder convention becomes five: `model · domain-services · usecases · infra · entrypoints`, with one doctrine sentence: `model/` holds data and pure rules, `domain-services/` holds operations that need ports. Audit the seven existing `domain/` folders before `domain-services` joins the lint layer set. | **Decided.** Step `.domainServices()`, folder `domain-services/` and type `DomainDeps` confirmed by the founder 2026-10-22. The child helper name `domainService(fn)` is still a proposal. |
| D2 | **The mechanism.** A builder method between `.infra()` and `.usecases()`, repeatable, allowed on either side of `.features()`. Each call compiles to one unit `<feature>/domain-services` (`#2` for a second call), placed in `units` in declaration order. Entries in one call never see each other. | Proposed |
| D3 | **Two exported deps types, each read from the stage above its consumers.** `export type DomainDeps = DepsOf<typeof <stage before the step>>` for domain-service files; the public `Deps = DepsOf<typeof <stage before .usecases()>>` is unchanged, so no existing usecase file changes. A second `domainServices` call after `.features()` exports one more type named by position. One `Deps` that includes the domain-service keys is rejected: `typeof extras → Pick<Deps> → typeof digestDeps → typeof extras` is a self-reference, TS7022 territory. The rule for authors: **a file imports the deps type of the stage before the step that registers it.** Any other choice is a loud compile error (TS2502, TS7022, TS2456; verified), never a silent loop. | Proposed |
| D4 | **A child names a parent's domain service by factory identity:** `needs({ extras: domainService(extras) })`. `domainService(fn)` returns a handle memoized per function (`WeakMap`), typed `Awaited<Exclude<ReturnType<typeof fn>, Failure>>`. The parent's `compile()` adds it to the existing `ownedInfra` map; `remapNeeds` is unchanged. The child imports the domain-service file, which imports only types from `feature.ts`, so there is no module cycle. A handle exported from the parent chain is rejected (import cycle, TDZ at load); automatic pass-down is rejected (implicit). | Proposed |
| D5 | **Fresh frozen deps copy per factory**, for the new step and for the existing `.usecases()`. Shallow `Object.freeze` of a copy holding only that stage's keys. A later or sibling key is then a type error and absent at runtime; a sneaky `Object.assign` throws `TypeError` at build. | Proposed |
| D6 | **Import-loop lint for feature folders.** Usecase and domain-service files take only `import type` from `feature.ts`, and no value import from a sibling usecase or domain-service file. A value import of a domain-service file is allowed only in the feature's `feature.ts` and a child's `feature.ts`. This closes the hoisted-function bypass and guarantees one instance per boot. Align `infra-runtime-imports` with nesting decision 10, unless D9 keeps the exception. | Proposed |
| D7 | **`provides` sees `usecases` only.** `ProvidesDeps = { usecases: UsecaseValues<U> }`. A trivial read becomes a one-line usecase: `export const listByItem = ({ repos }: Pick<Deps, 'repos'>) => repos.highlights.listByItem`. Every cross-feature call is then traced and supervised. A feature that hosts an app-level adapter and re-publishes it moves that adapter to app infra. | Proposed |
| D8 | **`entrypoints` see `usecases`, the request keys (`session`, `headers`, `principal`), and `entrypointOnly` needs.** Infra and plain needs leave `CoreServices` for entrypoints. `entrypointOnly` stays as the named exception: the gateway opens the transaction and takes the lock with it (36 `db`, 6 `locks` uses). The two leak sites are fixed. | Proposed |
| D9 | **May feature infra need another feature's `provides`?** The lint allows it today; nesting decision 10 forbids it; `composition-doctrine.md:293` says infra never depends on the domain. Allowing it is how domain objects crept into infra. Forbidding it means an adapter that genuinely translates another feature's output (an anti-corruption layer) must receive that output through a domain service or a usecase instead of a handle. | **Decided 2026-10-22: forbidden.** `infra-runtime-imports` bans any runtime import of a `feature.ts`, as nesting decision 10 says. Another feature's output reaches this feature through `needs` into a domain service or a usecase, never into an adapter. |

Rejected on the way:

- **A new unit kind with hooks (`engines`).** A slot defined by lifetime, with zero users that need a hook. Every framework surveyed puts hooks on the object.
- **A nested feature per domain service.** No Dot change and honest `needs`, but a "feature" with no behavior, an empty `.entrypoints()`, and it still cannot express `firstDigest`. It stays the right shape for a sub-context that has its own tables or doors.
- **Renaming `infra`.** `owns` was the best candidate. The word is right once domain objects leave it. A rename is about the size of the 2026-10-21 codemod for no reader gain.
- **One `.usecases()` call with a `uses: [...]` graph and a kernel sort.** Cycles are detected (TS7022) or, with string keys, only at runtime. "Declaration order is boot order" stays.
- **Collapsing units and features into one authoring shape.** The kernel is already one mechanism (`UnitRole`, `unit-contract.ts:573`). The chain exists to break the `Deps` type cycle. Collapsing it breaks typed `Deps`.
- **Sibling visibility inside one call.** Object key order is not a type-level concept. Two calls instead.

## 5. API sketch

`daily-digest/feature.ts`, with the D1 name:

```ts
const digestBase = defineFeature('daily-digest')
  .needs({ db: entrypointOnly(database.provides.db), locks: entrypointOnly(locking.provides.locks),
           entitlements: billing.provides.entitlements, signals: relevanceScoring.provides.relevanceSignals,
           clusterDetails: contentDeduplication.provides.clusterDetails, syntheses: crossDocumentIntelligence.provides.digestSyntheses,
           episodeCards: podcastSupport.provides.episodeCards, videoCards: youtubeIntegration.provides.videoCards,
           copilotInsights: aiCopilot.provides.digestInsights })
  .infra(store, transactions(database.provides.db));

/** What a domain service may ask for: needs and infra. Nothing below this line. */
export type DomainDeps = DepsOf<typeof digestBase>;

const digestDeps = digestBase
  .domainServices({ extras })             // built once, before the children: `deliver` needs it
  .features(compile, deliver);

/** What a usecase may ask for: needs, infra, domain services, children. */
export type Deps = DepsOf<typeof digestDeps>;
export const digestLogic = digestDeps.usecases({ getLatest, getSectionExtras /* … */ });
export const dailyDigest = digestLogic
  .provides({ digests: ({ usecases }) => ({ latest: usecases.getLatest }) })   // D7: usecases only
  .entrypoints(digestProcedures, digestSchedules);
```

`domain-services/extras.ts` (folder name follows D1):

```ts
import type { DomainDeps } from '../../feature';
import { DigestExtrasService } from './digest-extras-service';

/** The digest's cross-feature extras. A missing upstream degrades to an absent section. */
export const extras = (deps: Pick<DomainDeps, 'clusterDetails' | 'syntheses' | 'episodeCards' | 'videoCards' | 'copilotInsights'>) =>
  new DigestExtrasService(deps);
```

`usecases/get-section-extras.ts`: unchanged. `Pick<Deps, 'repos' | 'extras'>` now resolves `extras` from the domainServices step.

`features/deliver/feature.ts`:

```ts
import { domainService } from '@arki/dot/feature';
import { extras } from '../../domain-services/extras';
  .needs({ /* … */, extras: domainService(extras) })   // D4: by factory identity, no module cycle
```

`audio-transformation`, the three-caller case:

```ts
// domain-services/tts-generation.ts
export const ttsGeneration = ({ repos, tts, audioStorage }: Pick<DomainDeps, 'repos' | 'tts' | 'audioStorage'>) =>
  new TtsGenerationService(repos.audio, tts, audioStorage);  // calls tts.client() per run inside, as the infra comment requires
// feature.ts
  .infra(store, tts, audioStorage).domainServices({ ttsGeneration });
// usecases/generate-article-tts.ts: ({ ttsGeneration, repos }: Pick<Deps, 'ttsGeneration' | 'repos'>) => async (…) => …
```

Single-consumer helpers stay plain code built in the caller's factory body. `firstDigest` stays as it is.

## 6. Typing and cycle safety

- `S` (the domain-services record) is threaded through `FeaturesStage`, `UsecasesStage`, `ProvidesStage`, `EntrypointsStage`, `FeatureCore` and `CoreDeps` (`… & S & …`). New: `DomainServiceHandle`, `DomainServicesGuard`, `ChildDomainNeeds`, `ProvidesDeps`, `EntrypointServices`. `CoreHandles` unchanged.
- **Why a cycle cannot be written.** A domain-service factory's parameter type is `DepsOf` of the stage above it. That type cannot contain the factory, its peers, or anything below. A child's `domainService(fn)` handle names a value that exists before the child is declared. A ring of `defineFeature` consts is TS7022 at compile time and an ESM TDZ error at load. The kernel's capability check only looks backward (`E019`, `E020`). D5 makes the runtime object match the type. D6 closes the import bypass.
- **What Dot cannot promise:** call-time loops through a mutable event bus or registry. Out of scope; say so in `di.md`.
- **Type budget.** Features without the step pay one `EmptyShape` intersection. Probe `packages/dot/bench` against the 410k-instantiations, 50-feature baseline before step 2.

## 7. Guards

| Mistake | Compile time | Boot time |
|---|---|---|
| Domain-service key collides with a need, infra, child, another domain-service key, a usecase or a reserved alias | `DomainServicesGuard`: `DOT: a domain service key collides with …` | `ARKI_DOT_E027` keyCollision |
| Domain-service factory picks a key not declared above it (a peer, itself, a child when above `.features()`) | TypeScript's own: `Type '"delivery"' does not satisfy the constraint 'keyof DomainDeps'` | none possible; same gap as usecases today, stated openly |
| Child needs `domainService(fn)` the parent did not declare above `.features()` | `ChildrenGuard`: `DOT: a child needs a domain service this feature does not declare above .features()` | new `E034 domainServiceNotAbove` |
| `domainService(fn)` in a top-level feature | `NeedsGuard`: `DOT: domainService(...) names a parent's domain service; only a child may need it` | `E034` |
| domainServices step after `.usecases()` | the stage does not offer it | new `E035 stepOrder` if `stage()` does not already refuse it |
| Domain-service key used in `.provides()` or an entrypoint | absent from `ProvidesDeps` / `EntrypointServices`: `Property 'extras' does not exist` | `servicesOf` strips domain-service keys |
| `provides` factory reads `repos` | absent from `ProvidesDeps` | — |
| Procedure reads `context.repos` or `context.db` without `entrypointOnly` | absent from `EntrypointServices` | existing lint `procedures-call-usecases` |

## 8. Plan

1. **Founder:** D1 and D9.
2. **Hygiene first, no API change:** D5 frozen copies for `.usecases()`; D6 import-loop lint; lint alignment per D9; fix the 2 entrypoint leak sites. Each is its own commit.
3. **Step 1, the fixed slot:** one builder method between `.infra()` and `.features()`, `S` threaded, `DomainDeps`, `domainService(fn)`, guards E034/E035, `prepareUsecases` gains a `wrap` argument (trace∘supervise for usecases, trace only for domain services). Type tests: exact two-way `expectTypeOf` on `DomainDeps`, `Deps`, `ProvidesDeps`, `EntrypointServices`. Migrate `extras` and `tts-generation`.
4. **Step 2, repeatable on either side of `.features()`:** the type-budget probe, then the ordered `Parts` tuple. Migrate `firstDigest` only if a second consumer appears.
5. **D7 and D8:** split `CoreServices`; migrate the 13 `reader()` provides to usecases and the 5 adapter re-publications to app infra.
6. **Docs:** `composition-doctrine.md` § 4 (step rules; line 293), `di.md` (features as a chain; what Dot cannot promise), README chain section, `agent-guide.md` glossary, `llms.txt`, the `domain-driven-design` skill § Domain services and its placement table, the template (doc comment only; `post` and `auth` have no shared logic).
7. **Avocabo sweep, by the `domain-reviewer` agent, one feature per commit:** 11 multi-consumer helpers to the step; 13 per-call constructions to factory bodies; 11 infra domain objects out of infra; `extras`'s SQL into `contentDeduplication`.

## 9. Migration list (avocabo unless noted)

| Change | Sites | Examples |
|---|---|---|
| Helper with two or more consumers → domainServices step | ~11 | `audio-transformation` tts, `semantic-search` query understanding (after its adapter half moves to infra), `memory-and-retention` engagement, `billing` alerts |
| Per-call construction → factory body | 13 | `assign-new-items.ts:42`, `run-entity-resolve.ts:56-58`, `run-export.ts:116-124`, `run-maintenance.ts:33-36`, `search.ts:26` |
| Domain object under `infra/` → domainServices step or `model/` | 11 of 40 | `daily-digest/infra/extras.ts`, `auto-clustering/infra/namer.ts` (naming stays infra if it only wraps the LLM; the decision part moves) |
| `reader(repos.x, [...])` in `provides` → usecase | 13 | `highlights`, `podcast-support`, `youtube-integration`, `relevance-scoring`, `account`, `billing`, novelette `style` |
| Adapter re-published through `provides` → app infra | 5 | `vectorIndex`, `audioStorage`, `mailboxes` |
| Entrypoint reading past usecases | 2 | `highlights/entrypoints/idempotency.ts:21` |
| Usecase named `*Service` with one caller → inline or rename | several | `SummarizationService`, `FirstDigestFastPathService` |

## 10. Risks

- **The junk drawer.** The step collects every helper. Rule in the doctrine: a domain service has two or more consumers, or one child consumer; a single-consumer helper stays in the caller's factory body.
- **Two deps types per feature.** One more line in `feature.ts` and one rule for authors (D3). The rule is machine-checked: the wrong choice does not compile.
- **Classes in the step get no span.** Same as infra today. Document it.
- **D7 adds one-line usecases.** Thirteen files. Each becomes visible in `dot explain` and traced, which is the point.
- **D9 forbids a pattern the lint allowed.** Count the sites before deciding; the survey found one.
