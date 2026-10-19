# @arki/auth

Sign-in for Arki apps on Bun, TanStack Start and oRPC. You write one declaration (`defineAuth`) and bind it once on the server (`createAuth`, or the Dot plugin `auth`). The principal, the guards and the client read their types from that declaration and from your own user table. Every security claim points at a test that runs on PGlite.

The engine is [Better Auth](https://www.better-auth.com) 1.7.7. It stays behind this package's API. App code never imports `better-auth`.

Status: version 0.x, public. The old API (`defineAuthBackend`, `@arki/auth/schema`, `@arki/auth/create-auth` and the rest) is gone. [docs/migration.md](./docs/migration.md) maps every old name to the new one.

## Install

```sh
bun add @arki/auth
```

Add the peers for the entries you use: `@arki/dot` for `./dot`, `@orpc/server` for `./orpc`, React and TanStack for the UI entries.

## Quick start

Declare which sign-in methods the app has. This is plain data: no engine, no database. The browser can import it.

```ts
import { defineAuth } from '@arki/auth';

export const authDefinition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
});
```

Bind it on the server, guard procedures and add the form with the [recipes](#recipes) below.

## When not to use this

- Your app does not run on Bun with TanStack Start and oRPC. This package supports that one stack. It has no adapter for Next.js or Express.
- You need an identity provider for other apps (an OAuth server). This is sign-in for one app.
- You need multi-factor, passkeys, API keys or email one-time codes. They are not in this version (see [Limits](#limits)).
- You want a general Better Auth wrapper. App code never imports `better-auth` here.

## Runtime support

`@arki/auth` and `@arki/auth/password` are pure: no engine, no database, no Node built-ins. The password hash is scrypt in pure JavaScript (`@noble/hashes`). `scripts/smoke.mjs` loads `.`, `./ids`, `./zod`, `./password` and `./workspaces` through the export map and checks them.

`./ids` and `./workspaces` are pure too: `./ids` declares its ids with `defineId` (`@arki/contracts`), and the workspace database parts live on `./pg/workspaces`. `./zod` is pure and needs Zod. `bun run test:runtimes` runs the smoke script on Node, Bun, Deno and in a browser against the built `dist/`.

Every other entry is Node and Bun.

## Recipes

Five tasks cover most apps. Each one builds on the one before.

### Recipe 1: set up sign-in for an app

This builds sign-in for an app called Notes: password, magic link and Google, one extra user column (`plan`), and bearer tokens for a native client. First the tables, then the declaration, then the Dot plugin.

#### The tables (the app owns this file)

`createAuthTables` builds the four engine tables in your Postgres schema. You choose the ids and add your own columns. The engine never makes ids: every id comes from the table's `$defaultFn`.

```ts
// backend/src/features/auth/model/tables.ts
import { pgSchema, text } from 'drizzle-orm/pg-core';

import {
  accountIdColumns,
  createAuthTables,
  sessionIdColumns,
  userIdColumns,
  verificationIdColumns,
} from '@arki/auth/pg';

const schema = pgSchema('notes');

export const authTables = createAuthTables(schema, {
  fill: 'app',
  ids: {
    user: userIdColumns,
    session: sessionIdColumns,
    account: accountIdColumns,
    verification: verificationIdColumns,
  },
  columns: {
    user: {
      plan: text('plan', { enum: ['free', 'pro'] })
        .notNull()
        .default('free'),
    },
  },
});
export const { User, Session, Account, Verification, userForeignKeys } = authTables;
```

#### The declaration (shared by the backend and the start app)

`defineAuth` is plain data. It imports no engine and no database code, so the browser can import it too.

```ts continue
// shared/auth.ts
import { defineAuth } from '@arki/auth';

export const authDefinition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password', 'magicLink', 'google'],
  user: { fields: ['plan'] },
  sessions: { bearer: true },
});
```

#### The Dot plugin

`auth(definition, bindings)` takes `db` and `mail` from the Dot graph. `runtime` runs at boot, so `dot explain` and the manifest never read a secret. `providers` must hold exactly the social methods you enabled: here `google`, and nothing else.

```ts continue
// backend/src/infra/auth.ts
import type { PrincipalOf } from '@arki/auth';
import type { AuthOf } from '@arki/auth/dot';
import type { KV } from '@arki/kv';
import { auth } from '@arki/auth/dot';
import { tanstackStart } from '@arki/auth/tanstack-start';

declare const env: {
  readonly VITE_URL: string;
  readonly PRODUCTION_URL?: string;
  readonly AUTH_SECRET: string | undefined;
  readonly NODE_ENV: string;
  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;
  readonly RESEND_API_KEY: string;
};
declare const kv: KV;

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

The app adds the plugin after its database and mail plugins. `database` here comes from [the docs fixture](docs/examples/fixture.ts), which holds an in-memory database for the examples; use your own database plugin.

```ts continue
import { defineApp } from '@arki/dot';
import { mail } from '@arki/mail/dot';
import { resend } from '@arki/mail/http/resend';

import { database } from './fixture.ts';

export const app = defineApp('notes')
  .use(database)
  .use(mail(() => ({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'Notes <hi@notes.app>' })))
  .use(authn);
```

### Recipe 2: guard a procedure

The gateway reads the principal once per request. `guards()` gives three oRPC middlewares. Each one narrows `context.principal` to non-null.

```ts continue
// backend/src/entrypoints/middleware.ts and gateway.ts
import { os } from '@orpc/server';

import { AUTH_FAILURES } from '@arki/auth';
import { guards } from '@arki/auth/orpc';
import { errorMap } from '@arki/failure/orpc';

export type RequestContext = { readonly principal: Principal | null; readonly headers: Headers };
export const { authed, verified, role } = guards<RequestContext>();

export async function requestContext(request: Request, authService: Auth): Promise<RequestContext> {
  return { principal: await authService.principal(request.headers), headers: request.headers };
}

// backend/src/features/profile/entrypoints/procedures.ts
export const me = os
  .$context<RequestContext>()
  .errors(errorMap(...AUTH_FAILURES))
  .use(authed)
  .handler(({ context }) => ({
    id: context.principal.user.id, // UserId, branded
    email: context.principal.user.email, // string
    plan: context.principal.user.plan, // 'free' | 'pro'
  }));
export const adminStats = os
  .$context<RequestContext>()
  .errors(errorMap(...AUTH_FAILURES))
  .use(role('admin'))
  .handler(({ context }) => ({ askedBy: context.principal.user.id }));
```

`@arki/http` routes use a deriver instead:

```ts continue
// backend/src/features/profile/entrypoints/routes.ts
import { z } from 'zod';

import { withPrincipal } from '@arki/auth/http';
import { route, routes } from '@arki/http';

const getProfile = route.get('/profile', {
  id: 'profile',
  failures: AUTH_FAILURES,
  output: z.object({ plan: z.string() }),
});

export const profileRoutes = (authService: Auth) =>
  routes()
    .derive(withPrincipal(authService))
    .bind(getProfile, (_input, ctx) => ({ plan: ctx.principal.user.plan }));
```

### Recipe 3: add the sign-in form

```tsx skip="needs a TanStack Start app and a browser"
// start/src/features/auth/client.ts
import { createAuthClient, createSignInHandlers, SignInForm } from '@arki/auth/react';

import { authDefinition } from '../../../../shared/auth';

export const authClient = createAuthClient(authDefinition, { baseURL: getBaseUrl() });
export const useSession = authClient.useSession;

// start/src/routes/auth/$.tsx
function AuthPage() {
  return <SignInForm definition={authDefinition} handlers={createSignInHandlers(authClient, { redirectTo: '/' })} />;
}
```

The form shows only the methods the definition enables.

### Recipe 4: test code that needs a session

`testAuth` builds the same engine on an in-memory PGlite. `actingAs` makes a real session through it.

```ts run
// backend/src/features/profile/__tests__/me.test.ts
import { pgSchema, text } from 'drizzle-orm/pg-core';

import { defineAuth } from '@arki/auth';
import {
  accountIdColumns,
  createAuthTables,
  sessionIdColumns,
  userIdColumns,
  verificationIdColumns,
} from '@arki/auth/pg';
import { actingAs, testAuth } from '@arki/auth/testing';

const tables = createAuthTables(pgSchema('notes'), {
  fill: 'app',
  ids: {
    user: userIdColumns,
    session: sessionIdColumns,
    account: accountIdColumns,
    verification: verificationIdColumns,
  },
  columns: {
    user: {
      plan: text('plan', { enum: ['free', 'pro'] })
        .notNull()
        .default('free'),
    },
  },
});
const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
  sessions: { bearer: true },
});

const { auth, dispose } = await testAuth(definition, { tables });
try {
  const { headers } = await actingAs(auth, { email: 'alice@notes.test', plan: 'pro' });
  const principal = await auth.principal(headers);
  if (principal === null) throw new Error('expected a principal');
  if (principal.user.plan !== 'pro') throw new Error(`expected plan "pro", got ${principal.user.plan}`);
  if (principal.via !== 'cookie') throw new Error(`expected a cookie session, got ${principal.via}`);

  const phone = await actingAs(auth, { email: 'alice@notes.test' }, { via: 'bearer' });
  const sessions = await auth.sessions.list(principal);
  if (sessions.length !== 2) throw new Error(`expected 2 sessions, got ${sessions.length}`);

  await auth.sessions.revokeOthers(principal);
  if ((await auth.principal(phone.headers)) !== null) throw new Error('the other session should be revoked');
} finally {
  await dispose();
}
```

### Recipe 5: test the production boot

One test per backend imports the real auth module as production and checks that every declared method is on, that rate limiting is on and that cookies are secure. It sends no request, so it needs no database.

```ts skip="needs the app's auth module"
import { it } from 'vitest';

import { assertAuthBoots } from '@arki/auth/testing/production-boot';

it('the auth boots as declared in production', () => assertAuthBoots(() => import('../../infra/auth')));
```

## Public imports

| Entry                                        | Runtime                              | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arki/auth`                                 | Node, Bun, Deno, browser             | `defineAuth`, `definePolicies`, `AUTH_ERROR_CODES`, `AuthError`, `isAuthError`, `PASSWORD_MIN_LENGTH`, `AUTH_SECRET_MIN_LENGTH`; types `AuthDefinition`, `AccountOptions`, `AuthMethod`, `SocialMethod`, `IdTokenMethod`, `Seconds`, `VerifyEmailMode`, `WorkspacesOption`, `Principal`, `PrincipalOf`, `AnyPrincipal`, `AuthContext`, `PrincipalSession`, `PrincipalVia`, `AuthErrorCode`, `UserId`, `Policies`, `Policy`, `PolicyArgs`, `PolicyName`, `PolicyTree`, `AnyPolicies`, `PoliciesFor`, `PrincipalOfPolicies`, `SubjectOf`, `GroupOf`, `Loaded`, `RefusalOutcome` |
| `@arki/auth/ids`                             | Node, Bun, Deno, browser             | types `UserId`, `SessionId`, `AccountId`, `VerificationId`; `createUserId`, `createSessionId`, `createAccountId`, `createVerificationId`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@arki/auth/zod`                             | Node, Bun, Deno, browser (needs Zod) | `userIdSchema`, `sessionIdSchema`, `accountIdSchema`, `verificationIdSchema`, `organizationIdSchema`, `teamIdSchema`, `emailSchema`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@arki/auth/password`                        | Node, Bun, Deno, browser             | `hashPassword`, `verifyPassword`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@arki/auth/workspaces`                      | Node, Bun, Deno, browser             | `rankRole`, `roleAtLeast`, `scopeLevel`, `WorkspaceScopeError`; types `WorkspaceRole`, `WorkspaceContext`, `Scope`, `RowScope`, `ScopeLevel`, `OrganizationId`, `TeamId`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@arki/auth/pg`                              | Node, Bun                            | `createAuth`, `createAuthTables`, `auth*Columns`, `userIdColumns`, `sessionIdColumns`, `accountIdColumns`, `verificationIdColumns`, `assertAuthSecret`, `additionalFieldsFromColumns`, `authLinkInput`; types `Auth`, `AuthBindings`, `AuthRuntime`, `RateLimitBinding`, …                                                                                                                                                                                                                                                                                                    |
| `@arki/auth/pg/workspaces`                   | Node, Bun                            | `createWorkspaceTables`, `createWorkspaceForeignKeys`, `registerWorkspaceResource`, `getWorkspaceResource`, `resetWorkspaceRegistry`, `workspaceReadFilter`, `resolveWriteScope`, `canSeeRow`, `reassignScope`                                                                                                                                                                                                                                                                                                                                                                |
| `@arki/auth/dot`                             | Node, Bun                            | `auth`, `AuthOf`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@arki/auth/orpc`                            | Node, Bun                            | `guards` (`authed`, `verified`, `role`, `can`), `assertFound`, `assertOwnedOrNotFound`, `assertOwnedOrForbidden`; types `PrincipalGuard`, `PolicyGuard`, `PolicyLoader`                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@arki/auth/http`                            | Node, Bun                            | `withPrincipal`, `withOptionalPrincipal`, `authorize`, `authFailureHeaders`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@arki/auth/react`                           | browser                              | `createAuthClient`, `SignInForm`, `createSignInHandlers`, `resolveAuthClientBaseUrl`; types `AuthClient`, `AuthCapabilities`, `SignInFormProps`, `SignInLocalization`, …                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@arki/auth/react/templates`                 | browser                              | `AuthErrorPageTemplate`, `SignOutTemplate`, `VerifyRequestTemplate`, `LoginTemplate1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@arki/auth/tanstack-start`                  | Node, Bun, browser                   | `tanstackStart`, `createRequireAuth`, `ArkiAuthProvider`, `TanStackAuthProvider`; type `SignInRedirect`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@arki/auth/testing`                         | Node, Bun                            | `testAuth`, `actingAs`, `lastLink`, `lastMagicLink`, `TEST_AUTH_SECRET`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@arki/auth/testing/tanstack-start`          | Node, Bun                            | `createE2EHandler`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@arki/auth/testing/production-boot`         | Node                                 | `assertAuthBoots`, `emailModuleMock`, `applyProductionBootEnv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@arki/auth/testing/playwright`              | Node                                 | Playwright global setup and fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@arki/auth/env`, `@arki/auth/tweaks-column` | Node, Bun                            | unchanged helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Optional peers: `@arki/dot` for `./dot`, `@orpc/server` for `./orpc`, `@arki/http` for `./http`, React, `@arki/ui`, `@arki/icons` and TanStack for the UI entries, `@electric-sql/pglite`, `drizzle-kit` and `vitest` for the testing entries, `@playwright/test` for `./testing/playwright`.

## Failure behaviour

Auth failures are thrown as `AuthError` with a stable code. Handle each by its answer:

| Code             | Name                  | When                                                                                         | Answer                 |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------- | ---------------------- |
| `ARKI_AUTH_E001` | `invalidConfig`       | Unknown method or field, missing provider keys, bad duration, no limiter store in production | boot                   |
| `ARKI_AUTH_E002` | `weakSecret`          | Secret missing or shorter than 32 characters in production                                   | boot                   |
| `ARKI_AUTH_E003` | `mailRequired`        | A method sends mail and no mailer is bound                                                   | boot                   |
| `ARKI_AUTH_E004` | `principalShape`      | The engine's user lacks an exposed column                                                    | 500                    |
| `ARKI_AUTH_E005` | `testingInProduction` | A testing helper ran with `production: true`                                                 | 500                    |
| `ARKI_AUTH_E006` | `mailFailed`          | The mailer failed to send an auth mail                                                       | 500, generic message   |
| `ARKI_AUTH_E007` | `tableMissing`        | `workspaces` without its tables or session columns                                           | boot                   |
| `ARKI_AUTH_E008` | `policyNotDeclared`   | `can` checks a policy the procedure's contract meta does not name                            | 500                    |
| `ARKI_AUTH_E401` | `unauthenticated`     | No principal; a cookie and a bearer token together                                           | 401                    |
| `ARKI_AUTH_E403` | `forbidden`           | `role()` or `verified` refused                                                               | 403                    |
| `ARKI_AUTH_E429` | `rateLimited`         | The limiter refused                                                                          | 429 with `Retry-After` |
| `ARKI_AUTH_E503` | `storeUnavailable`    | The limiter store failed                                                                     | 503                    |

Transport guards use canonical failures: `auth.unauthenticated` (401, including expired sessions), `auth.forbidden` (403), `auth.not_found` (404), `auth.rate_limited` (429), and `auth.unavailable` (503). Engine errors above keep their existing codes internally. Declare failures with `.errors(errorMap(...AUTH_FAILURES))` on oRPC contracts or `failures: AUTH_FAILURES` on HTTP routes. HTTP derivers and policy handlers return canonical failure values; binding requires every inferred deriver failure in the route declaration. oRPC bridges preserve canonical code and data; clients use `reviveRpcError(error, AUTH_FAILURES)` or the HTTP client's automatic revival. Auth derivers set `WWW-Authenticate: Bearer` on 401 and retain limiter `Retry-After`. Policy handlers use `.bind(contract, authorize(...)(...), { failureHeaders: authFailureHeaders })` from `@arki/auth/http` for the same headers.

`resolvePrincipal`, `requirePrincipal`, `checkPrincipal` and `authorizePolicy` return values or their exact inferred canonical failures. `AUTH_PRINCIPAL_FAILURES` and `AUTH_POLICY_FAILURES` provide narrower declaration sets. Missing and hidden subjects use the same `ResourceMissing` definition, message and data.

Ownership assertions require the handler's declared `errors`: `assertFound(row, errors)`, `assertOwnedOrNotFound(row, actorId, errors)`, and `assertOwnedOrForbidden(row, actorId, errors)`. The former label argument was removed. Read assertions require `ResourceMissing`; mutation assertions also require `AccessDenied`. Declare those canonical definitions with `errorMap` before calling the helper.

```ts run
import { AUTH_ERROR_CODES, AuthError, isAuthError } from '@arki/auth';

const refusal = new AuthError(AUTH_ERROR_CODES.forbidden, 'You do not have access to this.');
if (!isAuthError(refusal) || refusal.status !== 403) throw new Error('E403 must answer 403');
```

## Limits

- **Origin and CSRF checks are forced on.** The engine skips its origin check when it thinks it runs under test. This package sets both checks on explicitly, so tests see the same checks as production.
- **A template validator defect throws.** `schema.validator_defect` remains a defect at the auth callback boundary; it is not converted to a delivery refusal.
- **A failed verify mail at sign-up is not E006.** The engine sends that mail in the background and only logs a failure. Asking for the mail again (`/send-verification-email`) and every magic-link request do return E006.
- **A magic link to an unknown email is a sign-up.** The request answers the same for known and unknown emails. With `magicLink: { signUp: false }` the link is refused when it is used, and no user is made.
- **The limiter store.** The rate limiter keeps its counts in your `@arki/kv` store, through the engine's `customStorage` hook, using only `getRateLimiter`. A store error answers 503. But when Redis is not ready at the moment `@arki/kv` creates a limiter, `@arki/kv` hands back an in-memory limiter, and this package cannot see that. Until `@arki/kv` can refuse instead, make sure Redis is up before the first request.
- **The limiter counts per client address**, not per account. Set `runtime().clientIp.header` behind a proxy.
- **`rateLimit: false` is refused in production.** `testAuth` uses it by default.
- **`rateLimit: { store: 'memory' }` counts per process.** Each replica has its own budget, so N replicas allow N times the attempts, and a restart resets the counts. Boot logs a warning naming the app. Use it only for a single-instance app with no Redis.
- **Workspaces need two session columns** (`activeOrganizationId`, `activeTeamId`) as well as the workspace tables.
- **`expo` is `false` by default.** Native apps turn it on.
- **Session tokens are stored as they are**, as the engine does. The cookie is signed, and lists never return the token.
- **Not in this version:** email one-time codes, multi-factor, API keys, passkeys, idle and absolute session timeouts, per-account rate budgets, breached-password checks, and auth mail through the outbox. None of them is exported in any form.

## Documentation

- [Reference](./docs/reference.md): the declaration, bindings, principal, policies, native sign-in, events, brands, endpoint contract, moving tables, password hashing, workspaces and testing.
- [Security evidence](./docs/security-evidence.md): each claim and the test that proves it, plus the ASVS 5.0 evidence map.
- [Agent guide](./docs/agent-guide.md): the short version, for agents.
- [Security review](./docs/security-review.md): the engine read line by line, check by check.
- [Migration guide](./docs/migration.md): old names to new, and the steps for each app.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues). Report a security problem privately to the maintainers, not in a public issue.
