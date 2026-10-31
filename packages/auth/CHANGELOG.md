# @arki/auth

## 0.3.1

### Patch Changes

- Updated dependencies [fac706c]
- Updated dependencies [7c8ab60]
- Updated dependencies [7be13e9]
  - @arki/dot@0.10.0
  - @arki/kv@0.5.0
  - @arki/mail@0.4.0
  - @arki/db@0.5.1
  - @arki/http@0.4.1

## 0.3.0

### Minor Changes

- 49deeb6: `@arki/auth` now runs on SQLite (libSQL) as well as Postgres. The auth and workspace tables are written once against the column kit of `@arki/db`, and the new entries `@arki/auth/sqlite` and `@arki/auth/sqlite/workspaces` build them on SQLite. `createAuth` reads Better Auth's adapter dialect from `db`; `AuthDb` accepts a libSQL database, and `AuthTables` takes tables of either dialect. `testAuth(definition, { tables, database: 'libsql' })` runs a test auth on in-memory libSQL. The Postgres tables are unchanged: drizzle-kit sees no difference, and their row types are the same.

  Breaking: `createAuthTables`, `createWorkspaceTables` and the `auth*Columns` helpers take a column kit instead of a `PgSchema`, and their columns are kit specs. Migrate `createAuthTables(schema, { ids: { user: userIdColumns, session: sessionIdColumns, account: accountIdColumns, verification: verificationIdColumns }, columns: { user: { tweaks: tweaksColumn().notNull().default(EMPTY_TWEAKS) } } })` to `const c = pgColumns(schema); createAuthTables(c, { ids: authIdSources, columns: { user: { tweaks: tweaksSpec(c).notNull().default(EMPTY_TWEAKS) } } })`, with `pgColumns` from `@arki/db/pg`. Extra columns become `c.text(...)`, `c.timestamp(...)`, `c.json(...)`; a custom id is `{ primaryColumn: () => c.text('id')... }` or `c.id(declaration)`. `createWorkspaceTables(schema, …)` becomes `createWorkspaceTables(pgColumns(schema), …)`. `tweaksColumn()` and the `*IdColumns` helpers for an app's own Postgres tables are unchanged.

  SQLite limits: timestamps keep milliseconds, not microseconds; case-insensitive matching covers ASCII letters only; unique-violation errors carry no constraint name. The workspace scoping kernel stays on `@arki/auth/pg/workspaces`.

- 8944628: `resolveWriteScope` and `reassignScope` return `AccessDenied` (403) for a write the actor may not make and `ResourceMissing` (404) for a move of a row the actor cannot see, instead of throwing `WorkspaceScopeError`, which reached the wire as a 500. `WorkspaceScopeError` stays for bugs in the caller. The handlers `createSignInHandlers` returns now resolve to a `SignInRefused` failure (`data.reason`: `credentials`, `unverified`, `rateLimited` or `unknown`) instead of throwing an `Error` with the server's text; `SignInForm` shows `credentialsError`, `unverifiedError` or `rateLimitedError` from its localization. `SignInFailure` is now derived from the new `SIGN_IN_FAILURE_REASONS` list. `createE2EHandler` answers its refusals with the shared failure envelope (`{ version, code, data? }`). Docs: reference.md updated.
- 36b4da8: Auth checks are plain steps (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 4).

  - `@arki/auth` adds `authed`, `verified` and `role(name)`: plain functions that read `ctx.principal` and narrow it to non-null, or refuse with `auth.unauthenticated` (401) / `auth.forbidden` (403). Attach them with the transport's `step()`: `impl.x.use(step(authed))` (`@arki/dot/orpc`), `routes().use(step(authed))` (`@arki/http`). The handler keeps the app's own principal type.
  - `@arki/auth/http` adds `principalFromHeaders(auth)`, a step that adds `principal` (`null` for a guest) from the request's credentials.
  - Breaking: `guards<C>()` is removed from `@arki/auth/orpc`. `const { authed } = guards<C>()` → `import { authed } from '@arki/auth'` and `.use(step(authed))`. `can(policies)(name, load)` is now imported directly from `@arki/auth/orpc`, same call shape.
  - Breaking: `withPrincipal(auth, options)` and `withOptionalPrincipal(auth)` are removed from `@arki/auth/http`. Use `.use(step(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))`, then `.use(step(authed, { failureHeaders: authFailureHeaders }))` (or `verified`, `role(name)`) on routes that need a signed-in caller.
  - Breaking: `@arki/http` removes `derive(key, fn)`, the bundle's `.derive()`, `Deriver`, `ErasedDeriver`, `BASE_CTX_KEYS` and `ARKI_HTTP_E007`. A keyed deriver becomes a step that returns an object: `.derive('db', fn)` → `.use(step(ctx => ({ db: fn(ctx) })))`. `verifyWebhook({ scheme })` is a step: `.use(step(verifyWebhook({ scheme })))` adds `ctx.webhook`. A route bundle's `derivers` field is renamed `stages` (it holds steps and arounds).
  - Fix: `@arki/http` steps after the first one see `ctx.url` and `ctx.signal` again (they were dropped when the context was extended). This fixes `@arki/live`'s endpoint, which reads `ctx.url` in its second stage.

### Patch Changes

- `package.json` lists `./react` and `./react/templates` in `arki.bundlerOnly`: they render `@arki/ui` source, so they load only inside a bundler. The release smoke checks them with a Vite build instead of a plain Node import.
- ff85471: Go to Definition works on mapped keys again. Handle maps (`unit.provides.x`, feature handles), `PolicyTree`, `SessionValues`, `CronPolicy.respond`, `ChartConfig.theme`, `Operations` and the oRPC utils tree now map `[K in keyof T as K & string]` instead of `[K in keyof T & string]`. The old form cut the link from each key back to its declaration, so the editor found no definition. Types are otherwise unchanged.
- 440c75f: Dot's kernel atom is now a **unit**, and its constructor says its role. Breaking (0.x, so a minor):

  - The builder has three steps, always in this order: `defineApp(name).infra(...).features([...]).entrypoints(...)`. `.use()`, `.useAll()` and `.serve()` are removed: write `.use(x)` as `.infra(x)`, `.useAll(list)` as `.infra(...list)`, and `.serve(x)` as `.entrypoints(x)`. `.infra(a, b)` checks the list in order, like separate calls.
  - `plugin({...})` → `infra({...})` for infrastructure (a database, a cache, a mailer, an outside client). `.infra(...)` mounts it.
  - A unit served from `.entrypoints(...)` is now `entrypoint({...})`.
  - `driven(features => plugin({...}))` → `infra.fromFeatures(features => unit({...}))`; `driver(features => plugin({...}))` → `entrypoint.fromFeatures(features => unit({...}))`. `unit({...})` is the role-less atom and belongs only inside `fromFeatures`.
  - `@arki/dot/plugin` → `@arki/dot/unit`. Every `Plugin*` type is now `Unit*` (`Unit`, `AnyUnit`, `UnitNeeds`, `UnitPhases`, ...); `Driver` / `Driven` → `EntrypointBinder` / `InfraBinder`; `DotPluginError` → `DotUnitError`; `testPlugin` → `testUnit`; `initPlugins` → `initUnits` (its factory method `.plugin` → `.infra`); a feature's `.plugins()` → `.units()`; the context key `$plugin` → `$unit`.
  - `UnitRole` is `'infra' | 'feature' | 'entrypoint'` (was `'feature' | 'driving'`, with infra unlabelled). Every mounted unit has a role, and the manifest shows it.
  - The builder checks the side: `.infra()` refuses an entrypoint, and `.entrypoints()` refuses an infra or feature unit, at compile time. An erased graph fails `configure()` with the new `ARKI_DOT_E033` (`DotLifecycleErrorCode.UnitOnWrongSide`).
  - OpenTelemetry attributes: `dot.plugin.*` → `dot.unit.*` and `dot.app.plugin.count` → `dot.app.unit.count`. Update dashboards and alerts that query them.
  - `dot explain --graph` groups the hexagon as `infra` / `features` / `entrypoints`.
  - Domain logic with no usecases is still a feature: `defineFeature('orders').needs({...}).provides({...}).entrypoints()`. The quickstart now teaches this shape.

  Not yet renamed: the manifest and diagnostics JSON keys (`plugins`, `plugin`, `registeringPlugin`). A follow-up renames them. `@arki/dot/plugin` and `plugin` stay as aliases of `@arki/dot/unit` and `infra` inside the monorepo until then, and will be removed before this ships.

  The adapters move to the new names and the new steps (`@arki/tanstack-start`'s `tanstackStart(...)` is now built with `entrypoint`, so it mounts only with `.entrypoints(...)`, as before).

  demo impact: drop-studio's and faultline's Dot code uses `plugin(...)` and `@arki/dot/plugin`; rename on their next upgrade.

- e132ad3: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
- 5d55e12: Docs only: `llms.txt` import paths list `./sqlite` and `./sqlite/workspaces`. No code change.
- 530b86a: `ArkiAuthProvider` takes an optional `onUserChange(userId: string | null)` prop. It is called with the signed-in user's id, or `null` when signed out, each time that changes (sign-in, sign-out, or a new session that replaced another user's). It is never called while the session is loading or failed to load, and not twice in a row for the same user. Use it for per-user cleanup, such as dropping the previous user's offline caches.
- Updated dependencies [5d55e12]
- Updated dependencies [a905468]
- Updated dependencies [c36e614]
- Updated dependencies [b992897]
- Updated dependencies [289ba73]
- Updated dependencies [ebc681b]
- Updated dependencies [6cc8655]
- Updated dependencies [440c75f]
- Updated dependencies [5d55e12]
- Updated dependencies [be8f8e2]
- Updated dependencies [c3e63ba]
- Updated dependencies [e132ad3]
- Updated dependencies [1e47612]
- Updated dependencies [e132ad3]
- Updated dependencies [49517e2]
- Updated dependencies [ba05496]
- Updated dependencies [164e25a]
- Updated dependencies [29520c1]
- Updated dependencies [8944628]
- Updated dependencies [88daaeb]
- Updated dependencies [b37115d]
- Updated dependencies [36b4da8]
- Updated dependencies [c1ed2a3]
- Updated dependencies [5d55e12]
- Updated dependencies [b435e76]
- Updated dependencies [517d297]
- Updated dependencies [1a897f8]
- Updated dependencies [9d408cf]
- Updated dependencies [e80211d]
- Updated dependencies [17e86d3]
  - @arki/http@0.4.0
  - @arki/db@0.5.0
  - @arki/dot@0.9.0
  - @arki/kv@0.4.0
  - @arki/mail@0.3.0

## 0.2.0

### Minor Changes

- `EMAIL_FROM` in `@arki/auth/env` now defaults to `noreply@example.com`. Set `EMAIL_FROM` in every app that sends auth mail.

- a531063: Authorization as plain functions. `definePolicies<{ order: Order }>()({ order: { view, refund } })` (from `@arki/auth`) groups policies by subject; each policy reads `{ principal, order }` and returns a boolean, and names like `order.refund` are read from the tree, so a typo does not compile. The optional `view` policy decides whether the principal may know the subject exists.

  - `@arki/auth/orpc`: `guards<C>()` now also returns `can`. `can(policies)('order.refund', load)` signs in, loads the subject by the procedure's input, runs the policy and puts the subject on the context (`context.order`). A guest is `UNAUTHORIZED` (E401) and the loader never runs; a missing subject or `view` false is `NOT_FOUND` with no auth code (it looks missing); the policy false is `FORBIDDEN` (E403).
  - The procedure's contract meta must name the same policy (`.meta({ policy: 'order.refund' })`), so `dot explain` lists it. A missing or different name is the new `ARKI_AUTH_E008` (500).
  - `@arki/auth/http`: `authorize(policies)(name, load, handler)` wraps an `@arki/http` handler with the same check (401, 404 `ARKI_HTTP_E404`, 403). It runs after input decoding, so `load` reads the typed `params` and `body`.
  - Every refusal after sign-in writes one debug line on `arki:auth` with the policy name, the principal id and the outcome (`missing`, `hidden`, `forbidden`).

- 9669a84: Preserve completed authentication when event correlation ID generation fails. Correlation IDs use the canonical branded AuthRequestId type, keep inbound header values unchanged, and report exact generation failures while omitting only the correlated event. Add safe default OpenTelemetry spans for HTTP authentication, principal reads, native sign-in, and observers without configuring an SDK.
- 4f074bd: Pass the auth secret only through config, and drop dead and native dependencies (W1-08).

  - `betterAuth` no longer writes `process.env.BETTER_AUTH_SECRET`. Each instance keeps its own secret, and two instances with different secrets reject each other's sessions.
  - In production, a missing secret or one shorter than 32 characters now throws at startup (`assertAuthSecret`, `AUTH_SECRET_MIN_LENGTH`).
  - `@arki/auth/password` now hashes with pure-JS scrypt (`@noble/hashes`) in Better Auth's format, so hashes work in both. Breaking: `comparePasswords(input, hash)` is replaced by `verifyPassword({ hash, password })`, and old bcrypt hashes are not accepted. `bcrypt` is removed.
  - `@auth/core` and `@auth/drizzle-adapter` are removed. The Auth.js email types are now local (`EmailProviderConfig`, `EmailProviderUserConfig`, `EmailTheme`).
  - `vitest` moves from dependencies to an optional peer, needed only by `@arki/auth/testing/production-boot`. Its `emailModuleMock()` now mocks `createEmailClient`.
  - `initAuth` and `ResendProvider` build their email client with `createEmailClient({ isDev, resend: { apiKey } })`.
  - New README: install plus recipes for Bun + TanStack Start, oRPC, magic link, workspaces and e2e helpers.

- 011ece7: Return exact ID generation failures from `defineId` and Auth generators, preserving
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

- 49a339e: RPC error maps retain their original failure definitions for exact revival by another contract adapter. Use `rpcFailureDefinitions` to read these references; wire JSON remains unchanged.

  Add reusable browser-safe action contracts, server execution ownership and scoped
  OpenTelemetry helpers. Native RPC/HTTP adapters parse and encode once while
  sharing canonical failures and explicit exposure, principal and approval policies.

  Breaking: HTTP boundaries and auth policies return typed canonical failure values;
  update callers that inspect legacy strings or expect thrown refusals. Retry
  ownership is explicit. MCP adds browser-safe contract annotations and callable
  tools that reuse the gateway's typed native client, preserve canonical failures,
  and enforce access, approval and result budgets. Hosts provide approval authority;
  the full MCP server and durable confirmation store remain separate work.

- 0cc54c4: `defineAuthBackend`'s default `generateId` now gives users a `usr_` id from the package's own user id factory (`createUserId`, the `UserId` of `@arki/contracts`). It used to give `user_<hex>`, which no `userIdSchema` accepts. Every other model keeps `<model>_<hex>`. Apps that pass their own `generateId` are unchanged; existing `user_` rows need a data migration to the `usr_` prefix.
- 8b3cc80: `@arki/auth/orpc` (new): ownership checks for oRPC procedures (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c). `assertFound(row, label)` throws oRPC `NOT_FOUND` for a missing row. `assertOwnedOrNotFound(row, actorId, label)` (reads) also answers `NOT_FOUND` for another user's row, so a stranger cannot tell the two apart. `assertOwnedOrForbidden(row, actorId, label)` (mutations) answers `NOT_FOUND` for a missing row and `FORBIDDEN` for another user's row, since the caller already had the id. All three narrow the row's type. `@orpc/server` is an optional peer dependency.
- 8f9c726: `@arki/auth` becomes a product: one definition, one Postgres-backed engine, and the principal, guards and client types inferred from your own tables. It is now public and ships built `dist/` files.

  Write the auth once with `defineAuth({ app, methods, … })` (root `.`, browser-safe: no engine, no Drizzle, no Zod) and build it on the server with `createAuth(definition, bindings)` (`./pg`). The client, the sign-in form and the Dot plugin read the same definition.

  Entries: `.`, `./ids`, `./zod`, `./password`, `./workspaces`, `./pg`, `./pg/workspaces`, `./dot`, `./orpc`, `./http`, `./react`, `./react/templates`, `./tanstack-start`, `./testing`, `./testing/tanstack-start`, `./testing/playwright`, `./testing/production-boot`, `./env`, `./tweaks-column`. Removed entries: `./create-auth`, `./define-auth-backend`, `./better-auth.config`, `./dot.config`, `./schema`, `./constants`, `./errors`, `./debug`, `./token`, `./security/rate-limit`, `./security/timing-attacks`, `./email/schema`, `./email/resendAuthProvider`, `./email/sendVerificationRequest`, `./client-base-url`, `./tanstack-start/e2e-handler`, `./tanstack-start/require-auth`, `./workspaces/server` and its four sub-entries.

  | Old                                                                                        | New                                                                                       |
  | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
  | `defineAuthBackend`, `initAuth`, `betterAuth`                                              | `defineAuth` (`.`) + `createAuth` (`./pg`)                                                |
  | `DefineAuthBackendOptions`, `DefinedAuth`, `AuthPluginOptions`, `AuthService`              | `AuthDefinition`, `AuthBindings`, `Auth<D, T>`, `AuthOf`                                  |
  | `auth(options)` (Dot)                                                                      | `auth(definition, bindings)` (`./dot`)                                                    |
  | `GenerateIdHook`, `createPrefixedIdHook`, `generateId`                                     | removed: the table makes ids                                                              |
  | `magicLink: { send, disableSignUp }`                                                       | `methods: ['magicLink']`, `magicLink: { signUp }`, `mail` binding                         |
  | `socialProviders`                                                                          | `runtime.providers`                                                                       |
  | `extraPlugins` / `enableExpo`                                                              | `plugins` / `expo`                                                                        |
  | `organization: { enabled, teams }`                                                         | `workspaces: { teams }`                                                                   |
  | `emailVerification`, `emailAndPassword` objects                                            | `verifyEmail: 'none' \| 'send' \| 'require'` + `methods`                                  |
  | `auth.api.getSession` (in apps)                                                            | `auth.principal(headers)`                                                                 |
  | `AuthUiConfig`, `SocialProviderId`, `SignInForm config`                                    | `SignInForm definition={…}`, `client.capabilities`, `SocialMethod`                        |
  | `AUTH_ERROR_MESSAGES`                                                                      | `AUTH_ERROR_CODES`, `AuthError`, `isAuthError`                                            |
  | `ensureRateLimitNotExceeded`                                                               | internal: the engine limiter takes `rateLimit: { store }`                                 |
  | `UserEmail`                                                                                | `emailSchema` (`./zod`)                                                                   |
  | `*IdSchema` on `.` / `./ids`                                                               | same names on `./zod`; `userVerificationIdSchema` → `verificationIdSchema`                |
  | `*IdFactory`                                                                               | `userIdColumns`, `sessionIdColumns`, `accountIdColumns`, `verificationIdColumns` (`./pg`) |
  | `UserVerificationId`, `createUserVerificationId`                                           | `VerificationId`, `createVerificationId` (`./ids`)                                        |
  | `ResendProvider`, `sendVerificationRequest`, `generateSecureToken`, `preventTimingAttacks` | removed                                                                                   |
  | `assertEmailPasswordEnabled`                                                               | `assertAuthBoots` (`./testing/production-boot`)                                           |
  | `createE2EHandler` (`./tanstack-start`)                                                    | same name on `./testing/tanstack-start`, `enabled` required                               |
  | `createRequireAuth(prefetch, { signInTo, … })`, `RequireAuthOptions`                       | `createRequireAuth(prefetch, signIn)` with `SignInRedirect`                               |
  | `debugAuth`…                                                                               | internal `arki:auth` logger                                                               |
  | `./schema`                                                                                 | `./pg`                                                                                    |
  | `./workspaces` (DB parts), `organizationIdSchema`, `teamIdSchema`                          | `./pg/workspaces`; schemas on `./zod`                                                     |
  | `organizationPlugin`, `WorkspacePluginOptions`                                             | removed: use `workspaces: { teams }`                                                      |
  | `ArkiAuthProvider` without `capabilities`                                                  | `capabilities` is required (`authClient.capabilities`)                                    |

  Also new: the rate limiter takes `{ store: 'memory' }` for one-process deployments; session hooks (`on.sessionCreating`, typed against your session table); `mailBrand` per request with an optional `appUrl` for custom link templates (`authLinkInput`); `account: { changeEmail, linking, delete }` settings; native sign-in with an id token (`auth.signInWithIdToken`, narrowed by `auth.supportsIdToken`); `SignInRedirect` for `createRequireAuth`. Ids are declared once with `defineId` from `@arki/contracts`: generated ids are `usr_` (and so on) plus 24 random letters and digits. The `./zod` id schemas still take a plain `string` and give the id type. The engine (`better-auth`) is pinned to an exact version.

- 4843eca: The lib owns the Better Auth table shapes; an app builds them with one call each.

  - `createAuthTables(schema, { naming, fill, ids, columns })` gains `fill` (`'app'`: Drizzle `$defaultFn` in the app; `'database'`: `DEFAULT now()` / `DEFAULT false` in the database, `NOT NULL`) and `columns` (the app's own columns per table, merged after the standard ones; a standard key replaces that column; the row types include them). It no longer adds the `tweaks` column: an app that wants it passes `columns: { user: { tweaks: tweaksColumn().notNull().default(EMPTY_TWEAKS) } }`.
  - Breaking: `fill` is required, on `createAuthTables` and on the column sets `authUserColumns`, `authSessionColumns`, `authAccountColumns`, `authVerificationColumns`. Existing callers pass `fill: 'app'` to keep their shape.
  - New `createWorkspaceTables(schema, { naming, fill, user, ids })` in `@arki/auth/workspaces` builds the five organization-plugin tables (`organizations`, `members`, `invitations`, `teams`, `team_members`) and returns them with `orgForeignKeys` / `teamForeignKeys` already bound.

### Patch Changes

- 7353e97: New entry `@arki/auth/schema`: Drizzle column sets `authUserColumns`, `authSessionColumns`, `authAccountColumns` and `authVerificationColumns` for the four Better Auth tables, plus `createAuthTables(schema, { ids })` that builds them in the standard shape for a new app. The app passes its own id columns; `naming` is `'snake'` or `'camel'`.
- 4f074bd: Security review fixes (W1-09). Magic-link tokens are now stored hashed, so a read of the verification table no longer yields working sign-in links. `createE2EHandler` without `allowEmail` now accepts only reserved `.test` addresses instead of every address. `reassignScope` now requires `current` (the row's stored owner and scope) and refuses to move a row the actor cannot see, so callers must pass it; the matching check is exported as `canSeeRow`, with the `RowScope` type. `ensureRateLimitNotExceeded` now lets exactly `limit` attempts through, always rejects with `RateLimitExceededError`, and keeps one limiter per limit and window instead of one per key. The full checklist is in `packages/auth/docs/security-review.md`.
- cbefc52: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
- 61f9592: `applyProductionBootEnv` (testing/production-boot) now stubs
  `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` (required by app env
  schemas after the Cloudflare Email Service outbound migration, D-ING-021) and
  no longer stubs `RESEND_API_KEY` (no app env requires it).
- 2c0b668: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- f2e9f69: `env()`, `resilience()`, `auth()`, `journal()`, `journalProjections()`, `queue()`, `durableScheduler()` and `outboxPlugin()` keep their plugin name in the type, so their handles carry `provider: 'env' | 'resilience' | …` instead of `string` and the feature builder's handle-identity checks apply around them. The three queue plugins gain an overload: with no `name` option the type carries the default name (`'queue'`, `'durable-scheduler'`, `'outbox'`); with `name: 'jobs'` it carries `'jobs'`.
- fe5a391: README rewritten for Bun, TanStack Start and oRPC: install, quick start, five recipes, limits and failure behaviour. The reference, security evidence and ASVS map move to `docs/reference.md` and `docs/security-evidence.md`. Added `AGENTS.md`. `ARKI_AUTH_E*` codes gain `@fix` and `@verify` tags. Doc examples that cannot run say why.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- Updated dependencies [5bc6390]
- Updated dependencies [cbefc52]
- Updated dependencies [31ec526]
- Updated dependencies [7ce6a18]
- Updated dependencies [8b3cc80]
- Updated dependencies [5d05b9c]
- Updated dependencies [115aa87]
- Updated dependencies [8e55924]
- Updated dependencies [d471284]
- Updated dependencies [ddcc363]
- Updated dependencies [47d296b]
- Updated dependencies [f56ab9f]
- Updated dependencies [232d3e8]
- Updated dependencies [5e4c630]
- Updated dependencies [3064b6a]
- Updated dependencies [7ce6a18]
- Updated dependencies [3359639]
- Updated dependencies [af3d5a1]
- Updated dependencies [7c05d9a]
- Updated dependencies [28cd943]
- Updated dependencies [932c9e4]
- Updated dependencies [232d3e8]
- Updated dependencies [966efcd]
- Updated dependencies [cbefc52]
- Updated dependencies [4f074bd]
- Updated dependencies [953991a]
- Updated dependencies [f6a15d0]
- Updated dependencies [2c0b668]
- Updated dependencies [011ece7]
- Updated dependencies [71dea3e]
- Updated dependencies [9281865]
- Updated dependencies [49a339e]
- Updated dependencies [536d17d]
- Updated dependencies [0c73d42]
- Updated dependencies [b9ae16f]
- Updated dependencies [5bc6390]
- Updated dependencies [953991a]
- Updated dependencies [62ec96a]
- Updated dependencies [232d3e8]
- Updated dependencies [7b4b5bf]
- Updated dependencies [195172e]
- Updated dependencies [cbefc52]
- Updated dependencies [f2e9f69]
- Updated dependencies [d11c9fb]
- Updated dependencies [ee69f29]
- Updated dependencies [b9d0a86]
- Updated dependencies [fce3e8c]
- Updated dependencies [a1d4ee6]
- Updated dependencies [5bc6390]
- Updated dependencies [f663cc9]
- Updated dependencies [e12e20a]
- Updated dependencies [61f9592]
- Updated dependencies [fe5a391]
- Updated dependencies [232d3e8]
- Updated dependencies [cbefc52]
- Updated dependencies [2ce7fe2]
- Updated dependencies [00519da]
- Updated dependencies [670554a]
- Updated dependencies [953991a]
  - @arki/db@0.4.0
  - @arki/http@0.3.0
  - @arki/mail@0.2.0
  - @arki/kv@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2
  - @arki/env@0.0.3
  - @arki/db@0.1.2
  - @arki/kv@0.1.2
  - @arki/emails@0.1.2

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/env@0.0.2
  - @arki/kv@0.1.1
  - @arki/db@0.1.1

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/contracts@1.0.0
  - @arki/log@1.0.0
  - @arki/db@0.1.1
  - @arki/kv@0.1.1
  - @arki/emails@0.1.1
