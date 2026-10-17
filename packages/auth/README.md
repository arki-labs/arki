# @arki/auth

Sign-in for Arki apps. You write one declaration (`defineAuth`) and bind it once on the server (`createAuth`, or the Dot plugin `auth`). The principal, the guards and the client read their types from that declaration and from your own user table. Every security claim below points at a test that runs on PGlite.

The engine is [Better Auth](https://www.better-auth.com) 1.7.7. It stays behind this package's API. App code never imports `better-auth`.

What it is not: a general Better Auth wrapper, a user-management UI, or an identity provider for other apps.

Status: version 0.x, still `private` in this workspace. The old API (`defineAuthBackend`, `@arki/auth/schema`, `@arki/auth/create-auth` and the rest) is still exported while apps move. [docs/migration.md](./docs/migration.md) maps every old name to the new one.

## The first 15 minutes

This builds sign-in for an app called Notes: password, magic link and Google, one extra user column (`plan`), and bearer tokens for a native client.

### 1. The tables (the app owns this file)

`createAuthTables` builds the four engine tables in your Postgres schema. You choose the ids and add your own columns. The engine never makes ids: every id comes from the table's `$defaultFn`.

```ts
// backend/src/features/auth/model/tables.ts
import { pgSchema, text } from 'drizzle-orm/pg-core';

import { accountIdFactory, sessionIdFactory, userIdFactory, userVerificationIdFactory } from '@arki/auth/ids';
import { createAuthTables } from '@arki/auth/pg';

const schema = pgSchema('notes');

export const authTables = createAuthTables(schema, {
  fill: 'app',
  ids: {
    user: userIdFactory,
    session: sessionIdFactory,
    account: accountIdFactory,
    verification: userVerificationIdFactory,
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

### 2. The declaration (shared by the backend and the start app)

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

### 3. The Dot plugin

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

The app adds the plugin after its database and mail plugins:

```ts skip="needs Postgres and a mail provider"
export const app = defineApp('notes')
  .use(database)
  .use(mail(() => ({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'Notes <hi@notes.app>' })))
  .use(authn);
```

### 4. Who is calling

The gateway reads the principal once per request. `guards()` gives three oRPC middlewares. Each one narrows `context.principal` to non-null.

```ts continue
// backend/src/entrypoints/middleware.ts and gateway.ts
import { os } from '@orpc/server';

import { guards } from '@arki/auth/orpc';

export type RequestContext = { readonly principal: Principal | null; readonly headers: Headers };
export const { authed, verified, role } = guards<RequestContext>();

export async function requestContext(request: Request, authService: Auth): Promise<RequestContext> {
  return { principal: await authService.principal(request.headers), headers: request.headers };
}

// backend/src/features/profile/entrypoints/procedures.ts
export const me = os
  .$context<RequestContext>()
  .use(authed)
  .handler(({ context }) => ({
    id: context.principal.user.id, // UserId, branded
    email: context.principal.user.email, // string
    plan: context.principal.user.plan, // 'free' | 'pro'
  }));
export const adminStats = os
  .$context<RequestContext>()
  .use(role('admin'))
  .handler(({ context }) => ({ askedBy: context.principal.user.id }));
```

`@arki/http` routes use a deriver instead:

```ts continue
// backend/src/features/profile/entrypoints/routes.ts
import { z } from 'zod';

import { withPrincipal } from '@arki/auth/http';
import { route, routes } from '@arki/http';

const getProfile = route.get('/profile', { id: 'profile', output: z.object({ plan: z.string() }) });

export const profileRoutes = (authService: Auth) =>
  routes()
    .derive(withPrincipal(authService))
    .bind(getProfile, (_input, ctx) => ({ plan: ctx.principal.user.plan }));
```

### 5. The client

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

### 6. A test

`testAuth` builds the same engine on an in-memory PGlite. `actingAs` makes a real session through it.

```ts run
// backend/src/features/profile/__tests__/me.test.ts
import { pgSchema, text } from 'drizzle-orm/pg-core';

import { defineAuth } from '@arki/auth';
import { accountIdFactory, sessionIdFactory, userIdFactory, userVerificationIdFactory } from '@arki/auth/ids';
import { createAuthTables } from '@arki/auth/pg';
import { actingAs, testAuth } from '@arki/auth/testing';

const tables = createAuthTables(pgSchema('notes'), {
  fill: 'app',
  ids: {
    user: userIdFactory,
    session: sessionIdFactory,
    account: accountIdFactory,
    verification: userVerificationIdFactory,
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

### 7. A production boot test

One test per backend imports the real auth module as production and checks that every declared method is on, that rate limiting is on and that cookies are secure. It sends no request, so it needs no database.

```ts skip="needs the app's auth module"
import { it } from 'vitest';

import { assertAuthBoots } from '@arki/auth/testing/production-boot';

it('the auth boots as declared in production', () => assertAuthBoots(() => import('../../infra/auth')));
```

## Entries

| Entry                                        | Runtime                  | What it gives you                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arki/auth`                                 | Node, Bun, Deno, browser | `defineAuth`, `AUTH_ERROR_CODES`, `AuthError`, `isAuthError`, `PASSWORD_MIN_LENGTH`, `AUTH_SECRET_MIN_LENGTH`; types `AuthDefinition`, `AuthMethod`, `SocialMethod`, `Principal`, `PrincipalOf`, `AuthContext` |
| `@arki/auth/ids`                             | Node, Bun                | id types, `create*Id`, `*IdFactory`                                                                                                                                                                            |
| `@arki/auth/zod`                             | Node, Bun                | `userIdSchema`, `sessionIdSchema`, `accountIdSchema`, `verificationIdSchema`, `organizationIdSchema`, `teamIdSchema`, `emailSchema`                                                                            |
| `@arki/auth/password`                        | Node, Bun, Deno, browser | `hashPassword`, `verifyPassword`                                                                                                                                                                               |
| `@arki/auth/pg`                              | Node, Bun                | `createAuth`, `createAuthTables`, `auth*Columns`, `assertAuthSecret`, `additionalFieldsFromColumns`                                                                                                            |
| `@arki/auth/pg/workspaces`                   | Node, Bun                | `createWorkspaceTables`, `createWorkspaceForeignKeys`, `registerWorkspaceResource`, `workspaceReadFilter`, `resolveWriteScope`, `canSeeRow`, `reassignScope`                                                   |
| `@arki/auth/workspaces`                      | Node, Bun                | `WorkspaceRole`, `rankRole`, `roleAtLeast`, `scopeLevel`, `WorkspaceScopeError`, and today also the database parts                                                                                             |
| `@arki/auth/dot`                             | Node, Bun                | `auth`, `AuthOf`                                                                                                                                                                                               |
| `@arki/auth/orpc`                            | Node, Bun                | `guards`, `assertFound`, `assertOwnedOrNotFound`, `assertOwnedOrForbidden`                                                                                                                                     |
| `@arki/auth/http`                            | Node, Bun                | `withPrincipal`, `withOptionalPrincipal`                                                                                                                                                                       |
| `@arki/auth/react`                           | browser                  | `createAuthClient`, `SignInForm`, `createSignInHandlers`, `resolveAuthClientBaseUrl`                                                                                                                           |
| `@arki/auth/react/templates`                 | browser                  | page templates                                                                                                                                                                                                 |
| `@arki/auth/tanstack-start`                  | Node, Bun, browser       | `tanstackStart`, `createRequireAuth`, `ArkiAuthProvider`, `TanStackAuthProvider`                                                                                                                               |
| `@arki/auth/testing`                         | Node, Bun                | `testAuth`, `actingAs`, `lastLink`, `lastMagicLink`                                                                                                                                                            |
| `@arki/auth/testing/tanstack-start`          | Node, Bun                | `createE2EHandler`                                                                                                                                                                                             |
| `@arki/auth/testing/production-boot`         | Node                     | `assertAuthBoots`                                                                                                                                                                                              |
| `@arki/auth/testing/playwright`              | Node                     | Playwright global setup and fixtures                                                                                                                                                                           |
| `@arki/auth/env`, `@arki/auth/tweaks-column` | Node, Bun                | unchanged helpers                                                                                                                                                                                              |

Optional peers: `@arki/dot` for `./dot`, `@orpc/server` for `./orpc`, `@arki/http` for `./http`, React, `@arki/ui`, `@arki/icons` and TanStack for the UI entries, `@electric-sql/pglite`, `drizzle-kit` and `vitest` for the testing entries, `@playwright/test` for `./testing/playwright`.

## The declaration

| Option                  | Default     | Meaning                                                                                                                                                                                           |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.name`              | required    | Appears in mail.                                                                                                                                                                                  |
| `app.key`               | required    | Lower-case letters, digits and dashes. Prefixes the cookies: `auth-<key>`.                                                                                                                        |
| `methods`               | required    | Any of `password`, `magicLink`, `google`, `apple`, `facebook`, `microsoft`, `github`.                                                                                                             |
| `user.fields`           | none        | Extra user columns the principal and the client see. Each must be a column of your user table.                                                                                                    |
| `user.signUpFields`     | none        | The fields a client may set at sign-up. Each must be in `user.fields`.                                                                                                                            |
| `verifyEmail`           | `'require'` | `'require'`: password sign-in waits for the link. `'send'`: the link is sent, sign-in works before it is used. `'none'`: no link.                                                                 |
| `sessions.expiresIn`    | 7 days      | Seconds.                                                                                                                                                                                          |
| `sessions.refreshEvery` | 1 day       | Seconds. Must be shorter than `expiresIn`.                                                                                                                                                        |
| `sessions.bearer`       | `false`     | Accept `Authorization: Bearer` tokens (native apps).                                                                                                                                              |
| `magicLink.signUp`      | `true`      | `false`: links are sign-in only.                                                                                                                                                                  |
| `workspaces`            | off         | `{ teams: boolean }`: organizations, and teams inside them.                                                                                                                                       |
| `account`               | all off     | `{ changeEmail?, linking?, delete? }`: change email (a verify link to the new address), link social accounts, delete the account (fresh session or password). Routes of an off switch answer 404. |
| `expo`                  | `false`     | Accept the Expo client.                                                                                                                                                                           |

Link lifetimes are fixed: magic link 5 minutes, password reset 15 minutes, email verification 60 minutes.

## The bindings

| Binding        | Meaning                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`           | A Drizzle Postgres database (node-postgres or PGlite). The Dot plugin takes it from the graph.                                                                                                                               |
| `tables`       | The tables from `createAuthTables` (and `createWorkspaceTables` with `workspaces`). Every `id` column needs a default (an id factory's `primaryColumn()`); a table without one fails at boot with E001.                      |
| `runtime()`    | Read once at boot: `url`, `productionUrl`, `secret`, `production`, `trustedOrigins`, `providers`, `clientIp`.                                                                                                                |
| `mail`         | A mailer from `@arki/mail`. Required when `password` or `magicLink` is on. The Dot plugin takes it from the graph.                                                                                                           |
| `templates`    | Replace the default `magicLink`, `verifyEmail` or `resetPassword` mail.                                                                                                                                                      |
| `mailBrand(e)` | Picks `appName` and `from` for each auth mail from `e.request`. Default: the app's name and the mailer's sender. See [Several brands on one backend](#several-brands-on-one-backend).                                        |
| `rateLimit`    | Required in production. `{ store: kv }`: one budget shared by every replica. `{ store: 'memory' }`: the engine's own limiter, one budget per process, with a warning at boot. `false` turns it off, outside production only. |
| `roles(user)`  | The principal's roles. A throwing resolver fails the request.                                                                                                                                                                |
| `on`           | Event observers and the session hooks (below).                                                                                                                                                                               |
| `plugins`      | Engine plugins, such as `tanstackStart()`. The escape hatch.                                                                                                                                                                 |

`runtime().clientIp.header` names the one header your ingress sets to the client address, such as `cf-connecting-ip`. The rate limiter reads only that header, so a spoofed `x-forwarded-for` cannot pick a new bucket.

## The principal and sessions

```ts skip="a type listing, not a program"
type Principal<User> = {
  readonly user: User; // core columns + `user.fields`, typed from your table
  readonly session: { id; createdAt; expiresAt; ipAddress; userAgent };
  readonly via: 'cookie' | 'bearer';
  readonly roles: readonly string[];
  readonly workspace?: { activeOrganizationId; activeTeamId }; // the selection, not proof of membership
};
```

`auth.sessions` manages sessions without exposing tokens:

- `list(principal)`: the principal's own sessions, with `current` marked. Never the token.
- `revoke(principal, id)`: one of the principal's own sessions. Someone else's id does nothing.
- `revokeOthers(principal)`: every session but the current one.
- `revokeUser(userId)`: every session of a user. A trusted server call.

## Native sign-in with an id token

A native app signs in with the platform SDK (Sign in with Apple, Google Sign-In) and gets an id token. The backend trades it for a session:

```ts skip="a route fragment, needs an app"
if (!auth.supportsIdToken('apple')) {
  return Response.json({ error: 'Apple sign-in is not configured.' }, { status: 501 });
}
const session = await auth.signInWithIdToken({ provider: 'apple', idToken, nonce, headers: request.headers });
if (session === null) return Response.json({ error: 'Sign-in failed.' }, { status: 401 });
// The app keeps session.token and sends `Authorization: Bearer <token>`.
return Response.json({ token: session.token, userId: session.principal.user.id });
```

- `provider` is typed: only the definition's enabled methods whose id tokens the engine verifies (`google`, `apple`, `facebook`, `microsoft`; GitHub has none). A disabled one does not compile.
- `auth.supportsIdToken(method)` answers the same question at run time and narrows `method`, so shared code can branch without naming a disabled provider.
- The engine checks the signature against the provider's published keys, the audience, the issuer, the age (one hour) and, when given, the nonce.
- Apple's native tokens name the app's bundle id as audience: set `runtime().providers.apple.appBundleIdentifier`. Without it the audience checked is `clientId` (the web Services ID).
- It needs `sessions: { bearer: true }`. Without it the call throws `ARKI_AUTH_E001`.
- `null` means refused: a token that fails a check, no email from the provider, an unverified email, or an existing user while `account.linking` is off. Nothing is written.
- `beforeUserCreate`, `sessionCreating`, `userCreated` and `signIn`/`signInFailed` run as for any sign-in. A `sessionCreating` refusal throws its `AuthError`.
- It is rate limited like sign-in: the same `rateLimit` store, rule and `runtime().clientIp.header` as the HTTP routes. Over the limit it throws `ARKI_AUTH_E429` (with `retryAfter` seconds) before the token is checked, and fires `signInFailed` with `'rateLimited'`. A failing store throws `ARKI_AUTH_E503`.

## Events

`on` takes plain functions. They run after the fact and never change the response. A throwing observer is logged. Events never carry tokens, cookies, headers or bodies.

| Event              | When                                                                                                        | Carries                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `beforeUserCreate` | Before a user row is written. Throw an `AuthError` to refuse.                                               | `email`, `method`, `request`                                                            |
| `userCreated`      | After a user row is written.                                                                                | `user`, `method`                                                                        |
| `sessionCreating`  | Before every session row is written. Returns the app's own session columns. Throw an `AuthError` to refuse. | `userId`, `request`                                                                     |
| `sessionCreated`   | After every session row is written.                                                                         | `userId`, `session` (`id`, dates, `ipAddress`, `userAgent`; no token)                   |
| `signIn`           | After a sign-in that set a session.                                                                         | `principal`, `method`, `requestId`                                                      |
| `signInFailed`     | After a sign-in that did not.                                                                               | `method`, `reason` (`credentials`, `unverified`, `rateLimited`, `unknown`), `requestId` |
| `passwordChanged`  | After a change or a reset.                                                                                  | `userId`, `reason`                                                                      |
| `signOut`          | After a sign-out.                                                                                           | `principal`                                                                             |

Most events come from a wrapper around the engine's handler. It reads the route, the status and the session cookie of each answer.

### Session hooks

`sessionCreating` and `sessionCreated` run for every session the engine makes: every sign-in path, sign-up with auto sign-in, and `actingAs` in tests. Use them for a column every session must carry, or for work at first sign-in.

```ts skip="a fragment of the bindings"
createAuth(authDefinition, {
  // ...
  on: {
    // `appContext` is an extra session column: createAuthTables(schema, { columns: { session: { appContext } } }).
    sessionCreating: ({ request }) => ({ appContext: appKeyOf(request) }),
    sessionCreated: ({ userId }) => ensureProfile(db, { accountId: userId }),
  },
});
```

- `sessionCreating` returns values for the app's own session columns, typed from your table. An unknown column, an engine column (`token`, `userId`, …) or a wrong value type does not compile. It may return nothing, and it may be async.
- A thrown `AuthError` refuses the session. The request answers 403 with the error's code, and no session row is written.
- `request` is absent when no request made the session (`actingAs`).
- `userId` and `session.id` have your tables' branded id types.
- `sessionCreated` is an observer: a throw is logged and the sign-in still succeeds.

## Several brands on one backend

One backend can sign users in for several sites, each with its own name. `mailBrand` picks the brand of each auth mail (magic link, verify, reset) from the request that asked for it:

```ts
import type { AuthMailBrandPicker } from '@arki/auth/pg';

const BRANDS: Readonly<Record<string, string>> = {
  'readingpath.com': 'ReadingPath',
  'strophie.com': 'Strophie',
};

export const brandOfHost: AuthMailBrandPicker = ({ request }) => {
  const host = request?.headers.get('x-forwarded-host') ?? request?.headers.get('host') ?? '';
  const appName = BRANDS[host];
  return appName === undefined ? {} : { appName, from: `${appName} <auth@example.com>` };
};
// createAuth(authDefinition, { ..., mailBrand: brandOfHost })
```

- `appName` goes into the template. `from` goes to the mailer's send call.
- A field you leave out keeps the default: the definition's `app.name` and the mailer's sender.
- With no request, or an unknown host, return `{}` to keep the default.
- A picker that throws fails the mail with E006. Nothing is sent under a wrong brand.
- Custom `templates` get the picked `appName` too.
- `appUrl` is the brand's own site. Only a custom template that declares `input: authLinkInput` (from `@arki/auth/pg`) receives it, as `data.appUrl`. The default `@arki/mail` templates take no site and ignore it. It must be an absolute http(s) URL, or the mail fails with E006.

```ts skip="a fragment of the bindings"
import { authLinkInput } from '@arki/auth/pg';
import { defineTemplate } from '@arki/mail';
import { magicLink } from '@arki/mail/templates/auth';

const brandedMagicLink = defineTemplate({
  name: magicLink.name,
  input: authLinkInput,
  subject: data => `Sign in to ${data.appName}`,
  text: data => `Sign in to ${data.appName}: ${data.url}`,
  html: data => page({ home: data.appUrl, action: data.url }),
});
// createAuth(authDefinition, { ..., mailBrand: brandOfHost, templates: { magicLink: brandedMagicLink } })
```

## Endpoint contract

`auth.handler` serves these routes under `/api/auth`. Only the routes of enabled methods exist.

| Route                                                                                                | Engine piece                                                             | Method                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `POST /sign-up/email`                                                                                | `emailAndPassword`                                                       | `password`                                                 |
| `POST /sign-in/email`                                                                                | `emailAndPassword`                                                       | `password`                                                 |
| `GET /verify-email`                                                                                  | `emailVerification`                                                      | `password` with `verifyEmail` not `'none'`                 |
| `POST /send-verification-email`                                                                      | `emailVerification`                                                      | `password` with `verifyEmail` not `'none'`                 |
| `POST /request-password-reset`                                                                       | `emailAndPassword.sendResetPassword`                                     | `password`                                                 |
| `POST /reset-password`                                                                               | `emailAndPassword`                                                       | `password`                                                 |
| `POST /change-password`                                                                              | core, with a hook that always revokes the other sessions                 | `password`                                                 |
| `POST /sign-in/magic-link`                                                                           | `magicLink` plugin, token stored hashed                                  | `magicLink`                                                |
| `GET /magic-link/verify`                                                                             | `magicLink` plugin                                                       | `magicLink`                                                |
| `POST /sign-in/social`                                                                               | `socialProviders`                                                        | `google`, `apple`, `facebook`, `microsoft`, `github`       |
| `GET /callback/:provider`                                                                            | `socialProviders` (`oAuthProxy` when `productionUrl` differs from `url`) | the same                                                   |
| `GET /get-session`                                                                                   | core                                                                     | every method                                               |
| `POST /sign-out`                                                                                     | core                                                                     | every method                                               |
| `GET /list-sessions`, `POST /revoke-session`, `POST /revoke-other-sessions`, `POST /revoke-sessions` | core                                                                     | every method                                               |
| `/organization/*`                                                                                    | `organization` plugin                                                    | `workspaces`                                               |
| `POST /change-email`, `POST /link-social`, `POST /delete-user`                                       | core                                                                     | `account.changeEmail`, `account.linking`, `account.delete` |
| `set-auth-token` answer header                                                                       | `bearer` plugin                                                          | `sessions.bearer`                                          |
| Expo origins and cookies                                                                             | `expo` plugin                                                            | `expo: true`                                               |

A 429 answer always carries `Retry-After`.

## Security evidence

Each claim is a test in `packages/auth/src`. All of them run with `bun run test`.

| Claim                                                                                                                                                         | Test                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sign-up, verify by mail, then sign in works end to end.                                                                                                       | `pg/flows/password.test.ts`                                                                 |
| `verifyEmail: 'require'` refuses sign-in until the link is used; `'send'` lets the user in.                                                                   | `pg/flows/password.test.ts`                                                                 |
| A reset changes the password, revokes every session and sends one mail.                                                                                       | `pg/flows/password.test.ts`                                                                 |
| A password change needs the current password and ends the other sessions.                                                                                     | `pg/flows/password.test.ts`                                                                 |
| An unknown email and a wrong password give the same status and body.                                                                                          | `pg/flows/enumeration.test.ts`                                                              |
| A reset request for an unknown email answers 200 and sends nothing.                                                                                           | `pg/flows/enumeration.test.ts`                                                              |
| A magic-link request answers the same for a known and an unknown email.                                                                                       | `pg/flows/enumeration.test.ts`                                                              |
| Sign-up for an existing email answers like a new one when verification is on.                                                                                 | `pg/flows/enumeration.test.ts`                                                              |
| A magic link is stored hashed, works once, and fails after it expires.                                                                                        | `pg/flows/magic-link.test.ts`                                                               |
| With `signUp: false`, a link to a stranger is refused at verify and makes no user.                                                                            | `pg/flows/magic-link.test.ts`                                                               |
| Ten simultaneous redemptions of one link make exactly one session (real Postgres).                                                                            | `pg/flows/challenge.pg.test.ts`                                                             |
| A client cannot set a field outside `signUpFields`, nor a hidden column.                                                                                      | `pg/flows/fields.test.ts`                                                                   |
| Session lists never hold a token; revoke is bound to the owner.                                                                                               | `pg/sessions.test.ts`                                                                       |
| A sign-in replaces the presented session token (no fixation).                                                                                                 | `pg/sessions.test.ts`                                                                       |
| A bearer token and a cookie give the same principal; both together are E401.                                                                                  | `principal.test.ts`                                                                         |
| A failing `roles` resolver fails the request; it never makes a guest.                                                                                         | `principal.test.ts`                                                                         |
| The principal has every exposed column and no hidden one; a missing column is E004.                                                                           | `principal.test.ts`                                                                         |
| Production cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, prefixed `auth-<key>`.                                                                           | `pg/security/cookies.test.ts`                                                               |
| A cookie POST from a foreign origin is refused; an untrusted `callbackURL` is refused.                                                                        | `pg/security/csrf.test.ts`                                                                  |
| The 4th sign-in in 10 seconds is 429 with `Retry-After`; two instances share one budget.                                                                      | `pg/security/rate-limit.test.ts`                                                            |
| A failing limiter store answers 503 E503, never a pass.                                                                                                       | `pg/security/rate-limit.test.ts`                                                            |
| A spoofed `x-forwarded-for` does not pick a new bucket when `clientIp.header` is set.                                                                         | `pg/security/rate-limit.test.ts`                                                            |
| A short or missing secret in production is E002, before the engine is built.                                                                                  | `pg/index.test.ts`                                                                          |
| Two instances with different secrets reject each other's cookies.                                                                                             | `pg/index.test.ts`                                                                          |
| A missing mailer (E003), missing workspace tables (E007), missing provider keys or a missing limiter store in production (E001) fail at boot.                 | `pg/index.test.ts`                                                                          |
| Events report method and reason, carry no secrets, and a throwing observer changes nothing.                                                                   | `pg/events.test.ts`                                                                         |
| `beforeUserCreate` can refuse a sign-up with its own code.                                                                                                    | `pg/events.test.ts`                                                                         |
| A failed magic-link mail answers E006 with a generic message.                                                                                                 | `pg/mail.test.ts`                                                                           |
| A database made before this API (old ids, old hashes, old sessions) works unchanged.                                                                          | `pg/upgrade.test.ts`                                                                        |
| Every method, bearer and workspaces combination boots; the tables make every id.                                                                              | `pg/assemble.test.ts`                                                                       |
| Guards answer E401 for a guest and E403 for a missing role or an unverified email.                                                                            | `orpc-guards.test.ts`                                                                       |
| `withPrincipal` answers 401 and 403 through a real `@arki/http` engine.                                                                                       | `http.test.ts`                                                                              |
| `actingAs` makes a real, listable, revocable session and refuses in production (E005).                                                                        | `testing/index.test.ts`                                                                     |
| The E2E handler is absent unless enabled, signs in `.test` addresses only, and is absent in production.                                                       | `testing/tanstack-start.test.ts`                                                            |
| The production boot check catches a declared method the engine does not serve.                                                                                | `testing/production-boot.test.ts`                                                           |
| Hashes made by `./password` verify in the engine and the other way round.                                                                                     | `password.test.ts`                                                                          |
| Type tests: the principal's user is typed from the table, `providers` matches the methods, guards narrow, node-postgres and PGlite fit `AuthDb` with no cast. | `principal.test-d.ts`, `definition.test-d.ts`, `orpc.test-d.ts`, `pg/db-boundary.test-d.ts` |

`pg/flows/challenge.pg.test.ts` starts a Postgres container. The other flow tests use PGlite.

## ASVS 5.0 evidence map

This is an evidence map. It is not a claim of ASVS Level 2. The item numbers were checked against the OWASP ASVS `v5.0.0` chapter files during planning, not again here.

| Area                       | Items with a test above                                                                                   | Items not covered here                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication (V6)        | 6.1.1, 6.1.3, 6.2.1–6.2.3, 6.2.5–6.2.7, 6.2.9–6.2.10, 6.3.1, 6.3.4, 6.4.3–6.4.4, 6.5.1–6.5.5, 6.8.1–6.8.2 | 6.2.4, 6.2.11–6.2.12 (breached and context password checks); 6.2.8 (passwords are NFKC-normalised, as the engine does, for compatibility); 6.3.3 (multi-factor)   |
| Session management (V7)    | 7.2.1–7.2.4, 7.4.1, 7.4.3                                                                                 | 7.3.1–7.3.2 (idle and absolute timeouts); 7.4.2, 7.4.4–7.4.5 (admin disable and session UI belong to the app); 7.5.1–7.5.2 (recent sign-in for sensitive actions) |
| Web frontend security (V3) | 3.3.1–3.3.4 (cookies), 3.5.1–3.5.2 (cross-site requests)                                                  | —                                                                                                                                                                 |
| Cryptography (V11)         | 11.4.2 (password hashing), 11.5.1 (random tokens)                                                         | —                                                                                                                                                                 |
| Security logging (V16)     | 16.3.1 (auth events)                                                                                      | —                                                                                                                                                                 |

## Errors

| Code             | Name                  | When                                                                                         | Answer                 |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------- | ---------------------- |
| `ARKI_AUTH_E001` | `invalidConfig`       | Unknown method or field, missing provider keys, bad duration, no limiter store in production | boot                   |
| `ARKI_AUTH_E002` | `weakSecret`          | Secret missing or shorter than 32 characters in production                                   | boot                   |
| `ARKI_AUTH_E003` | `mailRequired`        | A method sends mail and no mailer is bound                                                   | boot                   |
| `ARKI_AUTH_E004` | `principalShape`      | The engine's user lacks an exposed column                                                    | 500                    |
| `ARKI_AUTH_E005` | `testingInProduction` | A testing helper ran with `production: true`                                                 | 500                    |
| `ARKI_AUTH_E006` | `mailFailed`          | The mailer failed to send an auth mail                                                       | 500, generic message   |
| `ARKI_AUTH_E007` | `tableMissing`        | `workspaces` without its tables or session columns                                           | boot                   |
| `ARKI_AUTH_E401` | `unauthenticated`     | No principal; a cookie and a bearer token together                                           | 401                    |
| `ARKI_AUTH_E403` | `forbidden`           | `role()` or `verified` refused                                                               | 403                    |
| `ARKI_AUTH_E429` | `rateLimited`         | The limiter refused                                                                          | 429 with `Retry-After` |
| `ARKI_AUTH_E503` | `storeUnavailable`    | The limiter store failed                                                                     | 503                    |

oRPC guards throw `ORPCError('UNAUTHORIZED' | 'FORBIDDEN', { data: { code } })`. The `@arki/http` derivers throw `HttpError(status, code)`.

```ts run
import { AUTH_ERROR_CODES, AuthError, isAuthError } from '@arki/auth';

const refusal = new AuthError(AUTH_ERROR_CODES.forbidden, 'You do not have access to this.');
if (!isAuthError(refusal) || refusal.status !== 403) throw new Error('E403 must answer 403');
```

## Runtimes

`@arki/auth` and `@arki/auth/password` are pure: no engine, no database, no Node built-ins. The password hash is scrypt in pure JavaScript (`@noble/hashes`). `scripts/smoke.mjs` loads `.`, `./password` and `./workspaces` through the export map and checks them.

What is true today:

- The smoke script passes on Bun, which loads the TypeScript source.
- Node, Deno and the browser need the built JavaScript in `dist/`. The build emits only type declarations, so `bun run test:runtimes` does not pass yet.
- The root entry still exports the old server helpers (`defineAuthBackend`, `betterAuth`, `ResendProvider`), which load the engine.
- `./ids` and `./zod` load Drizzle through `@arki/db/id-factory`, so they are Node and Bun only.
- `./workspaces` still holds the database parts next to the pure ones.

Every other entry is Node and Bun.

## Moving existing tables

A database made with the old setup works unchanged: `pg/upgrade.test.ts` signs in an old user with an old password hash and keeps an old session alive. Only the code that declares the tables changes.

1. Replace the hand-written tables with one `createAuthTables(schema, options)` call that matches your columns:
   - `naming: 'camel'` when the columns are `emailVerified`; `'snake'` (default) when they are `email_verified`.
   - `fill: 'database'` when the database fills `createdAt`, `updatedAt` and `emailVerified` (`DEFAULT now()`); `fill: 'app'` when Drizzle's `$defaultFn` does.
   - `columns.<table>` adds your own columns. A standard key replaces that column, for example `account: { accessTokenExpiresAt: timestamp('expiresAt') }`.
2. Give every id column a `$defaultFn`. The engine runs with `generateId: false`, so the old `createPrefixedIdHook` is gone. An `@arki/auth/ids` factory (or any `createIdFactory` result) has one. Old ids stay valid: they are just strings to read.
3. Run `drizzle-kit generate`. The migration must be empty. If it is not, adjust `naming` and `columns` until it is.
4. With `workspaces`, add the workspace tables from `createWorkspaceTables` (`@arki/auth/pg/workspaces`) and two session columns: `session: { activeOrganizationId: text(...), activeTeamId: text(...) }`. Without them the auth refuses to boot (`ARKI_AUTH_E007`).
5. Expose extra user columns by name in `user.fields`. Delete the old `user.additionalFields` object: it is derived from the table now.

The column sets `authUserColumns`, `authSessionColumns`, `authAccountColumns` and `authVerificationColumns` are for apps that must build a table by hand. They take the same `naming` and `fill`.

## Password hashing

`@arki/auth/password` hashes with scrypt (N=16384, r=16, p=1, a 16-byte salt, a 64-byte key), in the same format as the engine. A hash made here verifies in the engine and the other way round.

```ts run
import { hashPassword, verifyPassword } from '@arki/auth/password';

const hash = await hashPassword('correct horse battery staple');
if (!(await verifyPassword({ hash, password: 'correct horse battery staple' }))) throw new Error('should verify');
if (await verifyPassword({ hash, password: 'wrong' })) throw new Error('should not verify');
```

## Workspaces

`workspaces: { teams: true }` turns on organizations and teams. The tables come from `createWorkspaceTables` in `@arki/auth/pg/workspaces`. `principal.workspace` holds the selected organization and team. It is a selection, not proof of membership: re-check membership before you trust it. The client from `createAuthClient` adds the organization API itself; do not pass `organizationClient()`.

The scoping kernel in `@arki/auth/pg/workspaces` builds read filters (`workspaceReadFilter`), checks writes (`resolveWriteScope`) and moves rows between scopes (`reassignScope`, which checks the row's current scope first). Register each scoped table once with `registerWorkspaceResource`.

## Testing

- `testAuth(definition, { tables })`: the real engine on an in-memory PGlite. Mail goes to a sink. Rate limiting is off unless you pass `rateLimit`. `rebuild()` makes a second auth over the same rows.
- `actingAs(auth, { email, ...columns }, { via, password })`: a real session through the engine. `password` sets the user's password so the form can sign in with it. It throws `ARKI_AUTH_E005` in production.
- `lastMagicLink(mail, email)` and `lastLink(mail, template, email)`: the link in the latest mail.
- `createE2EHandler({ auth, enabled, defaultEmail, password })` from `@arki/auth/testing/tanstack-start`: a POST route that hands Playwright a session. It answers 404 unless `enabled` is `true` and the auth is not in production. It signs in only `.test` addresses unless you pass `allowEmail`.
- `assertAuthBoots(() => import('...'))` from `@arki/auth/testing/production-boot`: the production boot check above.

## Known limits

- **Origin and CSRF checks are forced on.** The engine skips its origin check when it thinks it runs under test. This package sets both checks on explicitly, so tests see the same checks as production.
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

## More

- [Agent guide](./docs/agent-guide.md): the short version, for agents.
- [Security review](./docs/security-review.md): the engine read line by line, check by check.
- [Migration guide](./docs/migration.md): old names to new, and the steps for each app.
- [User vs Account](./docs/USER_VS_ACCOUNT.md): a user is a person, an account is a way to sign in.
