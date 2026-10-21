# @arki/contracts

## 0.3.0

### Minor Changes

- ee192bd: `defineId(...)` default ids (and `createIdBody`, so `@arki/db`'s `createId` / `createPrefixedId` too) are cuid2 ids, generated with `@paralleldrive/cuid2`: 24 characters, a letter first, then letters and digits, a SHA3 of time, a counter, a host fingerprint and random salt. The shape is unchanged (today's ids already passed `isCuid`), so stored ids and schemas keep working. Every random bit still comes from Web Crypto, resolved per generation: an unusable provider answers `RandomSourceUnavailable`, a provider that breaks the protocol answers `UnexpectedDefect`. Rejection sampling is gone with the old construction. A cuid2 costs about 100 µs on Bun and Node, so it is for entity identities; `format: 'uuid'` (used by `@arki/http`'s `requestId`) is unchanged and stays under a microsecond.

### Patch Changes

- c4f8bef: `defineId(...)`: `create()` and `is()` parse with the id schema's `z.compile()` fast path, built once per declaration, and `is()` answers `false` for a non-string without parsing. Same results; about half the time per call, which matters for `requestId` on every HTTP request.
- c794d12: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
- Updated dependencies [6601242]
- Updated dependencies [2000a7e]
- Updated dependencies [6601242]
  - @arki/failure@0.2.0
  - @arki/schema@0.2.0

## 0.2.0

### Minor Changes

- 57313a4: Cursor encoding and decoding return canonical failures. Database pagination
  preserves those outcomes before building SQL or returning a page. Check codec
  results and declare the original cursor failures at RPC boundaries.

  Failure lint rules now catch discarded callback returns, nested aggregate and
  iterator results, and blind acceptance through aliases or generic failure guards.
  Handle each outcome or forward it to its owner.
  Browser contract linting admits canonical failure definitions while keeping
  exception bridges in implementations.
  The exported lock conformance suite now checks each queued task's acquisition
  outcome before accepting its completion counts.

  Dot acquires telemetry instruments inside guarded execution, so importing before
  SDK setup works and broken reporters cannot replace application outcomes.

- 93f2972: Repair schema/type agreement across Drizzle validators, ID factories and AI configuration.

  Breaking: generated table validators no longer claim phantom `$type<T>` shapes. Use a runtime schema with `jsonColumn` and reuse it in explicit validator refinements for precise input/output types. Bare JSON columns retain the native runtime validator and its honest inferred type.

  Breaking: `createIdFactory(prefix)` infers its ID from the literal prefix; remove the former second type argument. Payments ID aliases now reflect the prefixes their generators already produce. Existing generated values and stored IDs are unchanged.

  Breaking: replace AI `SearchOptionsType` with `SearchSettings`, and `AIServiceConfigType` with `RAGServiceConfig`. The `@arki/ai/types` aliases use those same distinct names. Provider configuration and sanitizer patterns now share their actual validation schemas, preserving custom `RegExp` rules.

  See `docs/features/arki-framework/migrations/defined-once.md` for migration examples and compatibility notes.

- 232d3e8: Return exact ID generation failures from `defineId` and Auth generators, preserving
  successful prefixes and schema types. Validate and bound the entropy provider
  protocol; retain private causes and observe malformed asynchronous output.

  Propagate failures through modern consumers. Drizzle scalar defaults bridge at
  the foreign callback, while owned transactions restore canonical identity and
  roll back without replaying a returned refusal. FS upload creation returns before
  I/O and declares the same failure tuple in its native RPC contract.

  Handle `isFailure(id)` before using a generated ID. Derive stored ID types from
  the declaration or schema, not the generator's `ReturnType`. See Contracts'
  `docs/upgrades/typed-ids.md`. Legacy DB generators remain unchanged pending their
  separate consumer migration.

- 232d3e8: Add nominal domain kinds to `defineId(prefix, { kind })`, preserving canonical
  schema output through `IdOf` and DB columns without changing stored strings.
  The one-argument declaration remains compatible. Migrate each domain and its
  consumers together using the canonical schema at raw boundaries.

  Replace Journal's private Cuid2 generation with modern, supervised declarations.
  Public `jobId`, Journal write/worker/workflow/operator methods, webhook scheduling,
  Queue outbox scheduling and Mail outbox scheduling can now return precise
  `IdGenerationFailure` outcomes. Handle returned failures before treating an
  operation as committed or acknowledged. Partial writes roll back and adapters
  preserve the original failure.

  Admin actions can declare canonical `failures` and infer their exact execute
  outcomes. Refusals produce failed receipts; undeclared or thrown failures are
  supervised without leaking private metadata. Receipt replay and clients support
  canonical server-error statuses. Dot outbox producers retain the complete
  scheduling outcome.

  See Contracts' `docs/upgrades/domain-ids.md` and Journal's
  `docs/upgrades/id-generation-failures.md` for migration details and remaining
  identity-branding scope.

- b3cd0cc: Share bounded Web Crypto generation across modern and legacy IDs. Legacy
  `createId`, `createPrefixedId`, and factory `create`/`make`/`new` now return exact
  canonical generation failures. Preserve stored formats and prefixes, including
  legacy empty and punctuation prefixes, while removing the Cuid2 fallback to
  `Math.random`. Infer stored types from the successful schema and handle failures
  before side effects or string interpolation.

  Modern declarations use `defineId` with `IdOf` inferred from the canonical schema.
  Payment ID factory exports become browser-safe declarations; use `idColumns`
  for their table helpers. Payment provider creates and billing persistence return
  generation failures; webhook adapters must check these before acknowledgement.
  AI tombstone columns use modern declarations. Flow stops on returned failures;
  use `createFlow<State, Context>()(config)` to infer the exact node failure union.
  Ordinary patches cannot disguise a canonical failure through structural typing.

- 4c4d61a: Declare custom secure ID alphabets and lengths through `defineId`, retaining exact generation failures and canonical nominal types.

  Offline response-cache record IDs now use `idempotencyKeyId` and preserve their `idk_` plus 21-character URL-safe format. `IdempotencyRepository.store()` returns canonical failures and emits a default OpenTelemetry span. Its middleware reports cache failures without changing a completed handler response.

  Breaking: direct inserts into `idempotencyKeys` or a namespaced idempotency table must supply an ID. Generate and narrow `idempotencyKeyId.create()` before inserting; the table no longer hides fallible entropy in a Drizzle default. See the Offline cache-write upgrade guide.

- 395dfc0: Add UUID generation to canonical ID declarations and use one nominal Queue job
  identity across direct triggers, producer clients and local queues.

  Job triggers return precise generation failures before contacting the transport.
  Handle `JOB_TRIGGER_FAILURES` before using the successful ID. Generated keys keep
  their UUID format; explicit keys and pg-boss's durable duplicate mapping retain
  their stored values.

- 8b3cc80: Adds prefixed ids declared once and keyset pagination schemas (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c). Both are browser-safe (zod only).

  - `defineId('sty_')` returns `{ prefix, schema, create, is }`; `IdOf<typeof storyId>` is `` `sty_${string}` ``. The schema is a zod template literal (it exports a JSON Schema pattern); `create()` makes `prefix + 24` cuid2-shaped characters with Web Crypto. Prefixes are kept exactly as given, so stored ids stay valid. `assertUniqueIdPrefixes(...ids)` rejects a repeated prefix at compile time and runtime, and a prefix that starts another at runtime.
  - `keyset({ createdAt: 'desc', id: 'desc' })` declares a list order and its opaque base64url cursor (`encode`, `decode`, `cursor` schema; dates round-trip as dates). `pageInput(keyset, { defaultLimit, maxLimit })` and `page(itemSchema)` are the contract's input and output; `@arki/db/pagination` builds the query from the same declaration.

- fd18765: Coded errors and Hermes support. Every deliberate failure is now a `ContractsError` (a `TypeError`) with a stable `ARKI_CONTRACTS_E00n` `code` and a `remediation`; error messages now start with the code instead of `[contracts]`. Keyset cursors no longer use `TextDecoder`, which React Native (Hermes) lacks, so non-ASCII cursors decode there. The package now uses the shared library lint preset and a cross-runtime smoke test.
- e0cd44d: New `@arki/contracts/orpc` entry: one typed identity per oRPC contract procedure.
  `operations(contract)` returns a frozen tree with an `Operation` (`path`, `name`, `meta`,
  phantom input/output/error types) at every leaf; `operationAt(contract, path)` finds one;
  `OPERATION` (`'~op'`), `Identified<Op>` and `operationOf(carrier)` let client utils carry it.
  Types are inferred from the contract (`OperationOf<C>`, `InputOf`, `OutputOf`, `ErrorOf`, `MetaOf`).
  `@orpc/contract` is a new optional peer; the main entry still does not import it.

  Fix: `pageInput`'s client input now types the cursor as `string` (it was `unknown`), because
  `Keyset.cursor` is `z.ZodType<string, string>`.

  The package now runs `test:runtimes` (Node, Bun, Deno, browser, Hermes).

### Patch Changes

- 707ecb1: Generate UUID v4 with secure Web Crypto random bytes when native randomUUID is unavailable. Preserve canonical generation failures, native-provider defect supervision, stored ID schemas and the default 24-character generator.
- 953991a: Docs standard: new `AGENTS.md`, a README in the standard section order with `Limits`, `Failure behaviour` and a tested quick start, an `llms.txt` with import paths, a rewritten agent guide, `@fix` and `@verify` tags on every error code, and the 0.1.0 to 0.2.0 upgrade guide. Doc examples now run in `test:docs`.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- Updated dependencies [57313a4]
- Updated dependencies [f43d509]
- Updated dependencies [232d3e8]
- Updated dependencies [3f6d39f]
- Updated dependencies [7f9b4bb]
- Updated dependencies [86efafc]
- Updated dependencies [d541df1]
- Updated dependencies [f6a15d0]
- Updated dependencies [4913009]
- Updated dependencies [232d3e8]
- Updated dependencies [73ef41b]
- Updated dependencies [f796e5a]
  - @arki/failure@0.1.0

## 0.1.0

### Minor Changes

- 0e2ed57: Importing `@arki/contracts` no longer loads Drizzle. Breaking: everything that needs `drizzle-orm` moved to a new `@arki/contracts/drizzle` entry: `createSelectSchema`, `createInsertSchema`, `createUpdateSchema`, `COLUMN_ZOD_SCHEMA`, `bufferSchema`, `jsonSchema`, `literalSchema` and `createSchemaFactory`. The main entry keeps `z` (all of `zod/v4`), `formData` and the shared id types, and now runs the same on every runtime. The `./schema` entry and the `browser` export condition are gone. `drizzle-orm` is now an optional peer dependency. To upgrade, import the table schema helpers from `@arki/contracts/drizzle` and change `@arki/contracts/schema` to `@arki/contracts`.

## 0.0.5

### Patch Changes

- Add `UserId`, the `` `usr_${string}` `` id of a user, and `userIdSchema` to validate one. Packages that refer to a user (such as `@arki/payments` and `@arki/auth`) share this one type through contracts instead of depending on each other.

## 0.0.4

### Patch Changes

- Dependency refresh: `drizzle-orm` 1.0.0-rc.4, `zod` 4.6.5, `zod-form-data` ^3.0.3. No API changes.

## 0.0.3

### Patch Changes

- Lazy primitives family + client-surface hardening.

  - `@arki/ts`: new `once()` (zero-arg memo; memoizes `undefined`, sync throws retry, promises shared), hardened `lazyObject()` (`set`/`deleteProperty`/`getPrototypeOf` traps — writes land on the real instance, `instanceof` answers truthfully), new `Lazy<T>`/`resolveLazy` deferred-config vocabulary, and a `./testing` entry with `expectImportPure()` (subprocess import-purity harness).
  - `@arki/env`: `defineEnv` now delegates its lazy proxy to `lazyObject` (single trap implementation).
  - `@arki/kv`: `kv()` accepts a whole-options thunk — `kv(() => ({ url: env.REDIS_URL }))` — keeping declarations import-pure; per-field `url` thunk kept for compatibility.
  - `@arki/http`: `port` adopts `Lazy<number>`; documented why `bundles`/`features` tokens cannot defer (declaration-time wiring).
  - `@arki/contracts`: `browser` exports condition serves a zod-only build (no `drizzle-orm`) to client bundlers; table wrappers are node-only and fail loudly at bundle time from browser code.
  - `@arki/db` / `@arki/event-sourcing`: republished to align the `@arki/dot` peer range with 0.4.0.

## 0.0.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
