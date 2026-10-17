---
'@arki/auth': minor
---

`@arki/auth` becomes a product: one definition, one Postgres-backed engine, and the principal, guards and client types inferred from your own tables. It is now public and ships built `dist/` files.

Write the auth once with `defineAuth({ app, methods, … })` (root `.`, browser-safe: no engine, no Drizzle, no Zod) and build it on the server with `createAuth(definition, bindings)` (`./pg`). The client, the sign-in form and the Dot plugin read the same definition.

Entries: `.`, `./ids`, `./zod`, `./password`, `./workspaces`, `./pg`, `./pg/workspaces`, `./dot`, `./orpc`, `./http`, `./react`, `./react/templates`, `./tanstack-start`, `./testing`, `./testing/tanstack-start`, `./testing/playwright`, `./testing/production-boot`, `./env`, `./tweaks-column`. Removed entries: `./create-auth`, `./define-auth-backend`, `./better-auth.config`, `./dot.config`, `./schema`, `./constants`, `./errors`, `./debug`, `./token`, `./security/rate-limit`, `./security/timing-attacks`, `./email/schema`, `./email/resendAuthProvider`, `./email/sendVerificationRequest`, `./client-base-url`, `./tanstack-start/e2e-handler`, `./tanstack-start/require-auth`, `./workspaces/server` and its four sub-entries.

| Old | New |
| --- | --- |
| `defineAuthBackend`, `initAuth`, `betterAuth` | `defineAuth` (`.`) + `createAuth` (`./pg`) |
| `DefineAuthBackendOptions`, `DefinedAuth`, `AuthPluginOptions`, `AuthService` | `AuthDefinition`, `AuthBindings`, `Auth<D, T>`, `AuthOf` |
| `auth(options)` (Dot) | `auth(definition, bindings)` (`./dot`) |
| `GenerateIdHook`, `createPrefixedIdHook`, `generateId` | removed: the table makes ids |
| `magicLink: { send, disableSignUp }` | `methods: ['magicLink']`, `magicLink: { signUp }`, `mail` binding |
| `socialProviders` | `runtime.providers` |
| `extraPlugins` / `enableExpo` | `plugins` / `expo` |
| `organization: { enabled, teams }` | `workspaces: { teams }` |
| `emailVerification`, `emailAndPassword` objects | `verifyEmail: 'none' \| 'send' \| 'require'` + `methods` |
| `auth.api.getSession` (in apps) | `auth.principal(headers)` |
| `AuthUiConfig`, `SocialProviderId`, `SignInForm config` | `SignInForm definition={…}`, `client.capabilities`, `SocialMethod` |
| `AUTH_ERROR_MESSAGES` | `AUTH_ERROR_CODES`, `AuthError`, `isAuthError` |
| `ensureRateLimitNotExceeded` | internal: the engine limiter takes `rateLimit: { store }` |
| `UserEmail` | `emailSchema` (`./zod`) |
| `*IdSchema` on `.` / `./ids` | same names on `./zod`; `userVerificationIdSchema` → `verificationIdSchema` |
| `*IdFactory` | `userIdColumns`, `sessionIdColumns`, `accountIdColumns`, `verificationIdColumns`, `roleIdColumns`, `permissionIdColumns` (`./pg`) |
| `UserVerificationId`, `createUserVerificationId` | `VerificationId`, `createVerificationId` (`./ids`) |
| `ResendProvider`, `sendVerificationRequest`, `generateSecureToken`, `preventTimingAttacks` | removed |
| `assertEmailPasswordEnabled` | `assertAuthBoots` (`./testing/production-boot`) |
| `createE2EHandler` (`./tanstack-start`) | same name on `./testing/tanstack-start`, `enabled` required |
| `createRequireAuth(prefetch, { signInTo, … })`, `RequireAuthOptions` | `createRequireAuth(prefetch, signIn)` with `SignInRedirect` |
| `debugAuth`… | internal `arki:auth` logger |
| `./schema` | `./pg` |
| `./workspaces` (DB parts), `organizationIdSchema`, `teamIdSchema` | `./pg/workspaces`; schemas on `./zod` |
| `organizationPlugin`, `WorkspacePluginOptions` | removed: use `workspaces: { teams }` |
| `ArkiAuthProvider` without `capabilities` | `capabilities` is required (`authClient.capabilities`) |

Also new: the rate limiter takes `{ store: 'memory' }` for one-process deployments; session hooks (`on.sessionCreating`, typed against your session table); `mailBrand` per request with an optional `appUrl` for custom link templates (`authLinkInput`); `account: { changeEmail, linking, delete }` settings; native sign-in with an id token (`auth.signInWithIdToken`, narrowed by `auth.supportsIdToken`); `SignInRedirect` for `createRequireAuth`. Ids are declared once with `defineId` from `@arki/contracts`: generated ids are `usr_` (and so on) plus 24 random letters and digits. The `./zod` id schemas still take a plain `string` and give the id type. The engine (`better-auth`) is pinned to an exact version.
