# @arki/auth reference

The long form of the [README](../README.md). Each section is a task or a contract. The recipes in the README come first; read this when you need the exact option.

The code blocks that import from `./fixture.ts` use [the docs fixture](examples/fixture.ts). It holds a Notes app's auth tables, definitions, env and an in-memory auth, so the blocks compile. Replace it with your own modules.

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
| `db`           | A Drizzle Postgres database (node-postgres or PGlite). The Dot unit takes it from the graph.                                                                                                                                 |
| `tables`       | The tables from `createAuthTables` (and `createWorkspaceTables` with `workspaces`). Every `id` column needs a default (an id factory's `primaryColumn()`); a table without one fails at boot with E001.                      |
| `runtime()`    | Read once at boot: `url`, `productionUrl`, `secret`, `production`, `trustedOrigins`, `providers`, `clientIp`.                                                                                                                |
| `mail`         | A mailer from `@arki/mail`. Required when `password` or `magicLink` is on. The Dot unit takes it from the graph.                                                                                                             |
| `templates`    | Replace the default `magicLink`, `verifyEmail` or `resetPassword` mail.                                                                                                                                                      |
| `mailBrand(e)` | Picks `appName` and `from` for each auth mail from `e.request`. Default: the app's name and the mailer's sender. See [Several brands on one backend](#several-brands-on-one-backend).                                        |
| `rateLimit`    | Required in production. `{ store: kv }`: one budget shared by every replica. `{ store: 'memory' }`: the engine's own limiter, one budget per process, with a warning at boot. `false` turns it off, outside production only. |
| `roles(user)`  | The principal's roles. A throwing resolver fails the request.                                                                                                                                                                |
| `on`           | Event observers and the session hooks (below).                                                                                                                                                                               |
| `plugins`      | Engine plugins, such as `tanstackStart()`. The escape hatch.                                                                                                                                                                 |

`runtime().clientIp.header` names the one header your ingress sets to the client address, such as `cf-connecting-ip`. The rate limiter reads only that header, so a spoofed `x-forwarded-for` cannot pick a new bucket.

## The principal and sessions

```ts skip="a type sketch: the field types are elided, so it does not compile"
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

## Authorization: policies

A policy is a plain function: may this principal do this to this subject? Policies sit in groups, one group per subject, and are named `group.action`. The subject types are given once; the names are read from the tree.

```ts
import { definePolicies } from '@arki/auth';

type Order = { readonly id: string; readonly customerId: string; readonly status: 'open' | 'shipped' };

// features/orders/model/policies.ts: the rules, once, testable with a plain object
export const orderPolicies = definePolicies<{ order: Order }>()({
  order: {
    view: ({ principal, order }) => principal.roles.includes('staff') || order.customerId === principal.user.id,
    refund: ({ order }) => order.status !== 'shipped',
  },
});
```

- A policy gets `{ principal, <group> }`, never the input. Rules about input values belong in the schema or the usecase.
- `view` is optional and reserved. It decides whether the principal may know the subject exists.
- Pass the app's principal as the second type argument when a policy reads an exposed column: `definePolicies<{ order: Order }, Principal>()`.
- A group named `principal` does not compile. A policy name that is not in the tree does not compile.

One check runs in this order, on both transports:

| Step                                 | oRPC                              | `@arki/http`               |
| ------------------------------------ | --------------------------------- | -------------------------- |
| No principal. The loader never runs. | `auth.unauthenticated`            | 401 `auth.unauthenticated` |
| The loader returns `null`.           | `auth.not_found`                  | 404 `auth.not_found`       |
| The group's `view` returns `false`.  | `auth.not_found`, the same answer | 404, the same answer       |
| The named policy returns `false`.    | `auth.forbidden`                  | 403 `auth.forbidden`       |
| A policy throws.                     | rethrown (500), never a refusal   | rethrown (500)             |

Someone else's order looks exactly like a missing one, so ids cannot be probed. `order.view` itself is the `view` check alone.

oRPC: `can` is a standalone export of `@arki/auth/orpc`. Attach it with `.use(can(policies)(name, load))`; the loader's context type comes from the `.use()` chain. It signs in, loads the subject, runs the policy, and puts the subject on the context under its group's name. The loader gets the procedure's input and the full context, with `principal` non-null.

```ts continue
import { os } from '@orpc/server';
import { z } from 'zod';

import type { AnyPrincipal } from '@arki/auth';
import { AUTH_FAILURES } from '@arki/auth';
import { can } from '@arki/auth/orpc';
import { errorMap } from '@arki/failure/orpc';

type RequestContext = {
  readonly principal: AnyPrincipal | null;
  readonly orders: { byId(id: string): Promise<Order | null> };
};
export const refund = os
  .$context<RequestContext>()
  .errors(errorMap(...AUTH_FAILURES))
  .$meta<{ policy?: string }>({})
  .meta({ policy: 'order.refund' })
  .input(z.object({ id: z.string() }))
  .use(can(orderPolicies)('order.refund', ({ id }, { orders }) => orders.byId(id)))
  .handler(({ context }) => ({ refunded: context.order.id })); // context.order: Order
```

The procedure's meta must name the same policy. In a contract-first app that is the contract: `oc.$meta<{ policy?: string }>({}).input(…).meta({ policy: 'order.refund' })`. `can` compares the two on every call, and a missing or different name is `ARKI_AUTH_E008`, so the first test that calls the procedure catches the drift. `dot explain` reads the contract, so it lists the policy under the action (`↳ policy: order.refund`, and `meta.meta.policy` in `--json`).

`@arki/http`: `authorize` wraps the handler, because it must run after the input is decoded. The bundle adds `principal` first with `step(principalFromHeaders(auth))`; without it, the bind does not compile.

```ts continue
import { authFailureHeaders, authorize, principalFromHeaders } from '@arki/auth/http';
import { route, routes, step } from '@arki/http';

const refundOrder = route.post('/orders/:id/refund', {
  id: 'orders.refund',
  failures: AUTH_FAILURES,
  output: z.object({ refunded: z.string() }),
});

export const orderRoutes = (
  authService: { principal(headers: Headers): Promise<AnyPrincipal | null> },
  orders: RequestContext['orders'],
) =>
  routes()
    .use(step(principalFromHeaders(authService), { failureHeaders: authFailureHeaders }))
    .bind(
      refundOrder,
      authorize(orderPolicies)(
        'order.refund',
        ({ params }) => orders.byId(params.id),
        (_input, { order }) => ({ refunded: order.id }),
      ),
      { failureHeaders: authFailureHeaders },
    );
```

The loader's input is inferred on both transports: `({ id })` above needs no annotation.

Every refusal after sign-in writes one debug line on `arki:auth` (`DEBUG=arki:auth`): `Policy {policy} refused {principalId}: {outcome}`, with `outcome` one of `missing`, `hidden`, `forbidden`. A guest is not logged.

Workspaces: `principal.workspace` is only the selection. The loader checks membership (it may query) and returns a subject that carries the checked workspace context. The policy only decides.

## Native sign-in with an id token

A native app signs in with the platform SDK (Sign in with Apple, Google Sign-In) and gets an id token. The backend trades it for a session:

```ts
import { auth } from './fixture.ts';

export async function signInWithApple(request: Request, idToken: string, nonce: string): Promise<Response> {
  if (!auth.supportsIdToken('apple')) {
    return Response.json({ error: 'Apple sign-in is not configured.' }, { status: 501 });
  }
  const session = await auth.signInWithIdToken({ provider: 'apple', idToken, nonce, headers: request.headers });
  if (session === null) return Response.json({ error: 'Sign-in failed.' }, { status: 401 });
  // The app keeps session.token and sends `Authorization: Bearer <token>`.
  return Response.json({ token: session.token, userId: session.principal.user.id });
}
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

```ts
import { createAuth } from '@arki/auth/pg';

import { appKeyOf, authDefinition, bindings, db, ensureProfile } from './fixture.ts';

createAuth(authDefinition, {
  ...bindings, // db, tables and runtime
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

```ts
import { authLinkInput } from '@arki/auth/pg';
import { defineTemplate } from '@arki/mail';
import { magicLink } from '@arki/mail/templates/auth';

import { page } from './fixture.ts';

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

## Moving existing tables

A database made with the old setup works unchanged: `pg/upgrade.test.ts` signs in an old user with an old password hash and keeps an old session alive. Only the code that declares the tables changes.

1. Replace the hand-written tables with one `createAuthTables(schema, options)` call that matches your columns:
   - `naming: 'camel'` when the columns are `emailVerified`; `'snake'` (default) when they are `email_verified`.
   - `fill: 'database'` when the database fills `createdAt`, `updatedAt` and `emailVerified` (`DEFAULT now()`); `fill: 'app'` when Drizzle's `$defaultFn` does.
   - `columns.<table>` adds your own columns. A standard key replaces that column, for example `account: { accessTokenExpiresAt: timestamp('expiresAt') }`.
2. Give every id column a `$defaultFn`. The engine runs with `generateId: false`, so the old `createPrefixedIdHook` is gone. The `*IdColumns` helpers on `@arki/auth/pg` (or any `idColumns` / `createIdFactory` result from `@arki/db`) have one. Old ids stay valid: they are plain strings to read.
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
