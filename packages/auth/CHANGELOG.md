# @arki/auth

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
