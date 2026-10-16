# Moving to the new `@arki/auth` API

The old API had one big options object (`defineAuthBackend`) that each app filled in. The new API splits it in two:

- `defineAuth` (from `@arki/auth`): plain data about the app's auth. The backend, the start app and the sign-in form share it.
- `createAuth` (from `@arki/auth/pg`) or the Dot plugin `auth` (from `@arki/auth/dot`): the runtime bindings. Database, tables, secrets, mail, limiter store.

Existing databases keep working. Only code changes. `src/pg/upgrade.test.ts` proves an old user, an old password hash and an old session work with the new factory.

The old exports stay until every app has moved. Then they are deleted in one step. There are no compatibility shims after that.

## Old name → new name

| Old                                                                                        | New                                                                                    | Why                                                                                                                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `defineAuthBackend`, `initAuth`, `betterAuth`                                              | `defineAuth` (`@arki/auth`) + `createAuth` (`@arki/auth/pg`)                           | One declaration and one factory. The engine is no longer exported.                                                             |
| `DefineAuthBackendOptions`, `DefinedAuth`, `AuthPluginOptions`, `AuthService`              | `AuthDefinition`, `AuthBindings`, `Auth`, `AuthOf`                                     | The declaration and the runtime bindings are different things.                                                                 |
| `auth(options)` from `@arki/auth/dot.config` or `@arki/auth/dot`                           | `auth(definition, bindings)` from `@arki/auth/dot`                                     | The same definition as the factory and the client.                                                                             |
| `GenerateIdHook`, `createPrefixedIdHook`, `generateId`                                     | removed                                                                                | The table makes every id (`generateId: false`).                                                                                |
| `magicLink: { send, disableSignUp }`                                                       | `methods: [..., 'magicLink']`, `magicLink: { signUp }`, the `mail` service             | The method is data. The sender is the Dot `mail` service.                                                                      |
| `socialProviders`                                                                          | `runtime().providers`                                                                  | Credentials are runtime values, keyed by the enabled methods.                                                                  |
| `extraPlugins`                                                                             | `plugins`                                                                              | —                                                                                                                              |
| `enableExpo`                                                                               | `expo`                                                                                 | —                                                                                                                              |
| `organization: { enabled, teams }`                                                         | `workspaces: { teams }`                                                                | The package already calls them workspaces.                                                                                     |
| `emailVerification`, `emailAndPassword` objects                                            | `verifyEmail: 'none' \| 'send' \| 'require'` + `methods`                               | Three real choices.                                                                                                            |
| `user.additionalFields`                                                                    | `user.fields` (+ `user.signUpFields`)                                                  | The engine's field list is derived from the table.                                                                             |
| `auth.api.getSession(...)` in apps                                                         | `auth.principal(headers)`                                                              | One safe, typed projection.                                                                                                    |
| `AuthUiConfig`                                                                             | `definition` (and the client's `capabilities`)                                         | One source of truth for the form.                                                                                              |
| `AUTH_ERROR_MESSAGES`                                                                      | `AUTH_ERROR_CODES`, `AuthError`, `isAuthError`                                         | Coded errors, like `MAIL_ERROR_CODES`.                                                                                         |
| `ensureRateLimitNotExceeded`                                                               | internal                                                                               | The engine's limiter gets a shared store: `rateLimit: { store: kv }`.                                                          |
| `UserEmail` (`@arki/auth/email/schema`)                                                    | `emailSchema` (`@arki/auth/zod`)                                                       | Zod schemas live on `./zod`.                                                                                                   |
| `*IdSchema` from `@arki/auth/ids`                                                          | the same names from `@arki/auth/zod`                                                   | Zod schemas live on `./zod`.                                                                                                   |
| `ResendProvider`, `sendVerificationRequest`, `generateSecureToken`, `preventTimingAttacks` | removed                                                                                | Dead or misleading.                                                                                                            |
| `assertEmailPasswordEnabled`                                                               | `assertAuthBoots` (`@arki/auth/testing/production-boot`)                               | It checks every declared method, not only password.                                                                            |
| `createE2EHandler` from `@arki/auth/tanstack-start`                                        | `createE2EHandler` from `@arki/auth/testing/tanstack-start`, with `enabled`            | Absent unless a test mode turns it on.                                                                                         |
| `createRequireAuth(prefetch, { signInTo, ... })`                                           | `createRequireAuth(prefetch, redirect)`                                                | A typed redirect callback instead of a cast. Today the old signature is still the exported one; it changes when the apps move. |
| `debugAuth`, `debugPassword`, `debugToken` (`@arki/auth/debug`)                            | internal `arki:auth` logger                                                            | Loggers use the `arki:` category.                                                                                              |
| `@arki/auth/schema`                                                                        | `@arki/auth/pg`                                                                        | Database code lives on the `./pg` entry.                                                                                       |
| `@arki/auth/workspaces/server*`                                                            | `@arki/auth/pg/workspaces` (tables, kernel) and `@arki/auth/workspaces` (pure helpers) | The same split.                                                                                                                |
| `organizationPlugin`                                                                       | internal                                                                               | Engine plugin objects are not public.                                                                                          |
| `@arki/auth/constants`, `@arki/auth/errors`                                                | `@arki/auth`                                                                           | Pure values live on the root entry.                                                                                            |
| `@arki/auth/client-base-url`                                                               | `@arki/auth/react`                                                                     | —                                                                                                                              |
| `user.deleteUser`, `user.changeEmail`, `account.accountLinking`                            | `account: { delete, changeEmail, linking }` in the definition                          | No old-address confirmation mail and no delete-confirmation mail.                                                              |

Unchanged: `assertFound`, `assertOwnedOrNotFound`, `assertOwnedOrForbidden`, `hashPassword`, `verifyPassword`, `createAuthTables`, `createWorkspaceTables`, `tweaksColumn`, `ArkiAuthProvider`, `TanStackAuthProvider`.

## Steps for one app

Do these in order. Each step leaves the app compiling.

### 1. Tables

Open the app's auth tables file (often `backend/src/features/auth/model/tables.ts` or `schema.ts`).

1. Build the tables with `createAuthTables(schema, { naming, fill, ids, columns })` from `@arki/auth/pg`. Match the existing columns: `naming: 'camel'` for `emailVerified`, `'snake'` for `email_verified`; `fill: 'database'` when the database fills timestamps, `'app'` when Drizzle does.
2. Make sure every id column has a `$defaultFn`. An `@arki/auth/ids` factory or a `createIdFactory` result has one. The engine no longer makes ids.
3. With workspaces: add `session: { activeOrganizationId: text(...), activeTeamId: text(...) }` and the tables from `createWorkspaceTables` (`@arki/auth/pg/workspaces`).
4. Run `drizzle-kit generate`. The migration must be empty. If it is not, fix `naming` or `columns`. Never apply a non-empty diff to make it pass.

### 2. Definition

Create `shared/auth.ts` (or the app's shared folder) with `defineAuth`:

```ts
import { defineAuth } from '@arki/auth';

export const authDefinition = defineAuth({
  app: { name: APP_NAME, key: APP_KEY },
  methods: ['password', 'magicLink', 'google'],
  user: { fields: ['segment'] }, // the old user.additionalFields names
  verifyEmail: 'send', // the app's current behavior; the default is 'require'
});
```

Choices to make per app, from the old config:

- **Methods.** List what the app serves in production today. Add `password` only if the old config passed `emailAndPassword` itself: the old code switched password sign-in on by its own outside production only.
- **Social providers turned on by env.** The old configs often added Google only when its env vars were set. Methods are now fixed in the definition, so the client and the server agree. Either list the provider and require its env vars, or leave it out.
- **`verifyEmail`.** Keep the app's current behavior: `requireEmailVerification: true` → `'require'`; a verify mail without the requirement → `'send'`; no verify mail → `'none'`.
- **Password reset.** With `password`, reset is on and sends the `resetPassword` mail. An app that threw in `sendResetPassword` to block resets must decide: allow resets, or drop `password` for magic links.
- **Magic-link sign-up.** `disableSignUp: true` → `magicLink: { signUp: false }`.
- **Sessions.** Copy a custom `session.expiresIn` / `updateAge` to `sessions.expiresIn` / `refreshEvery` (seconds). Native apps that send bearer tokens need `sessions: { bearer: true }` and `expo: true`.

### 3. Server

Replace the old auth module (`backend/src/core/auth.ts`, `backend/src/infra/auth/*`, or `core/auth/config.ts`) with the Dot plugin:

```ts
import { auth } from '@arki/auth/dot';
import { tanstackStart } from '@arki/auth/tanstack-start';

export const authn = auth(authDefinition, {
  tables: authTables,
  runtime: () => ({
    url: env.VITE_URL,
    productionUrl: env.PRODUCTION_URL,
    secret: env.AUTH_SECRET,
    production: env.NODE_ENV === 'production',
    providers: { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } },
    clientIp: { header: 'cf-connecting-ip' },
  }),
  rateLimit: { store: kv },
  plugins: [tanstackStart()],
});
export type Auth = AuthOf<typeof authn>;
export type Principal = PrincipalOf<Auth>;
```

- The app must use `@arki/mail/dot`'s `mail(...)` plugin before `authn`. The old `magicLink.send` callbacks go away. A custom mail (for example a localized magic link) becomes a `templates` entry.
- A test-only magic-link capture becomes `lastMagicLink(mail, email)` in tests.
- Production needs `rateLimit: { store: kv }` from the app's `@arki/kv` instance. An app with one instance and no Redis may write `rateLimit: { store: 'memory' }` instead. It counts per process, and boot logs a warning.
- `onAPIError` and other engine options have no binding. Use `on` (events) for observers and `beforeUserCreate` for a waitlist. Anything else goes through `plugins`, and needs a review.
- `databaseHooks.session.create.before` that adds a column (such as `appContext`) becomes `on.sessionCreating`. Return only the columns, not the whole row. The `session` table must declare the column through `createAuthTables(schema, { columns: { session: { appContext } } })`.

  ```ts skip="before and after"
  // Before
  databaseHooks: { session: { create: { before: data => Promise.resolve({ data: { ...data, appContext: appKey } }) } } },
  // After
  on: { sessionCreating: () => ({ appContext: appKey }) },
  ```

- `databaseHooks.session.create.after` becomes `on.sessionCreated({ userId, session })`. `userId` is already your branded `UserId`, so drop the `as UserId` cast. A throw there is logged and no longer fails the sign-in.
- Auth mails that pick the brand from the request host (kapodopera's `resolveBrand`) become `mailBrand: ({ request }) => ({ appName, from })`. The app's own React mail becomes a `templates` entry; it receives the picked `appName`. See "Several brands on one backend" in the README.
- Tables whose `id` has no default (a plain `text('id').primaryKey()` plus `generateId`) fail at boot with E001. Use `createAuthTables` or an id factory's `primaryColumn()`; the engine makes no ids.

### 4. Who is calling

- Gateway: `const principal = await services.auth.principal(request.headers)`. Delete `auth.api.getSession` calls.
- oRPC: `export const { authed, verified, role } = guards<RequestContext>()` from `@arki/auth/orpc`. Replace the app's own `protectedProcedure` session checks.
- `@arki/http`: `routes().derive(withPrincipal(auth))` from `@arki/auth/http`.
- Delete every `user.id as UserId` and `user as UserModel`. The principal is typed from the table.

### 5. Start app

- Import id schemas from `@arki/auth/zod`, not `@arki/auth/ids`.
- Pass `definition={authDefinition}` to `SignInForm` instead of an `AuthUiConfig`.
- Move `createE2EHandler` to `@arki/auth/testing/tanstack-start` and pass `enabled` from an explicit test-mode flag.
- `createRequireAuth(prefetch, redirect)`: pass a callback that throws the router's `redirect(...)`.

### 6. Tests

- Replace the production boot test's `assertEmailPasswordEnabled(...)` with `assertAuthBoots(() => import('../../infra/auth'))`.
- Use `testAuth` and `actingAs` from `@arki/auth/testing` for tests that need a signed-in user.

### 7. Check

```sh
turbo run typecheck lint test --filter=@<app>/backend --filter=@<app>/start --force
grep -rln "from 'better-auth" apps/<app>/backend/src | wc -l          # 0
grep -rn "user\.id as UserId\|user as UserModel" apps/<app>/backend/src  # nothing
```

Commit one app at a time, by pathspec.
