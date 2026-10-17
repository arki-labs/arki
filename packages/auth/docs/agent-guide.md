# @arki/auth for agents

Read this before changing code that signs users in or reads who is calling. [`llms.txt`](../llms.txt) is the short index. When the two disagree, this guide wins. The [README](../README.md) is the long overview.

## The model

1. **One declaration.** `defineAuth({ app, methods, user, verifyEmail, sessions, magicLink, workspaces, expo })` is plain data from `@arki/auth`. It imports no engine and no database code, so the backend, the start app and the sign-in form share the same object.
2. **One factory.** `createAuth(definition, bindings)` from `@arki/auth/pg` builds the engine on Postgres (node-postgres or PGlite). In a Dot app, `auth(definition, bindings)` from `@arki/auth/dot` does the same with `db` and `mail` taken from the graph.
3. **Types come from the tables.** `user.fields` names extra columns of the app's user table. The principal's `user` has the core columns plus those, typed from the table. `user.id` is the table's branded id.
4. **One way to read the caller.** `auth.principal(headers)` returns a `Principal` or `null`. It reads a cookie or a bearer token. Both on one request is `ARKI_AUTH_E401`.
5. **The engine is Better Auth 1.7.7.** It serves the routes under `/api/auth` through `auth.handler`. `auth.engine` exists for tests and the E2E handler. App code never calls it.
6. **Boot refuses unsafe setups.** A weak secret, a missing mailer, a missing rate-limit store in production, missing workspace tables or an unknown field name all throw a coded `AuthError` when the auth is built.
7. **Fail closed.** A failing rate-limit store answers 503. A failing `roles` resolver fails the request. Neither ever lets a request through or makes a guest.
8. **Policies are plain functions.** `definePolicies<{ order: Order }>()({ order: { view, refund } })` from `@arki/auth`. A policy reads `{ principal, order }` and returns a boolean. `can` (oRPC) and `authorize` (`@arki/http`) load the subject and run one policy.

## Task map

### Add sign-in to an app

1. Build the tables with `createAuthTables` (`src/schema/index.ts`, exported from `@arki/auth/pg`).
2. Declare the auth with `defineAuth` (`src/definition.ts`) in a file both the backend and the start app import.
3. Add the Dot plugin `auth(definition, bindings)` (`src/dot.ts`) after the `db` and `mail` plugins.
4. Name the types: `type Auth = AuthOf<typeof authn>` and `type Principal = PrincipalOf<Auth>`.
5. Serve `auth.handler` on `/api/auth/*` and put `await auth.principal(request.headers)` in the request context.

```ts
import { pgSchema, text } from 'drizzle-orm/pg-core';

import type { PrincipalOf } from '@arki/auth';
import type { AuthOf } from '@arki/auth/dot';
import type { KV } from '@arki/kv';
import { defineAuth } from '@arki/auth';
import { auth } from '@arki/auth/dot';
import {
  accountIdColumns,
  createAuthTables,
  sessionIdColumns,
  userIdColumns,
  verificationIdColumns,
} from '@arki/auth/pg';

declare const env: { readonly URL: string; readonly AUTH_SECRET: string | undefined; readonly NODE_ENV: string };
declare const kv: KV;

export const authTables = createAuthTables(pgSchema('notes'), {
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

export const authDefinition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password', 'magicLink'],
  user: { fields: ['plan'] },
});

export const authn = auth(authDefinition, {
  tables: authTables,
  rateLimit: { store: kv },
  runtime: () => ({ url: env.URL, secret: env.AUTH_SECRET, production: env.NODE_ENV === 'production' }),
});
export type Auth = AuthOf<typeof authn>;
export type Principal = PrincipalOf<Auth>;
```

### Protect a procedure or a route

1. oRPC: `export const { authed, verified, role } = guards<RequestContext>()` from `@arki/auth/orpc` (`src/orpc.ts`). Each guard narrows `context.principal` to non-null.
2. `@arki/http`: `routes().derive(withPrincipal(auth))` from `@arki/auth/http` (`src/http.ts`). Options: `{ verified: true }`, `{ role: 'admin' }`.
3. A guest gets 401 `ARKI_AUTH_E401`. A missing role or an unverified email gets 403 `ARKI_AUTH_E403`.

```ts
import { os } from '@orpc/server';

import type { AnyPrincipal } from '@arki/auth';
import { guards } from '@arki/auth/orpc';

type RequestContext = { readonly principal: AnyPrincipal | null };
const { authed, role } = guards<RequestContext>();

export const whoAmI = os
  .$context<RequestContext>()
  .use(authed)
  .handler(({ context }) => context.principal.user.id);
export const adminOnly = os
  .$context<RequestContext>()
  .use(role('admin'))
  .handler(() => 'ok');
```

### Authorize with a policy

1. Write the rules in the feature's `model/policies.ts`: `export const orderPolicies = definePolicies<{ order: Order }>()({ order: { view: …, refund: … } })` (`src/policies.ts`). `view` is optional: `false` answers like a missing row (404). The action `false` answers 403.
2. oRPC: `export const { can } = guards<RequestContext>()`, then `impl.refund.use(can(orderPolicies)('order.refund', ({ id }, { usecases }) => usecases.findOrder(id)))`. The handler reads `context.order` and `context.principal`.
3. Name the policy in the contract too: `oc.$meta<{ policy?: string }>({})…meta({ policy: 'order.refund' })`. A missing or different name is `ARKI_AUTH_E008` on the first call. `dot explain` shows it as `↳ policy: order.refund`.
4. `@arki/http`: `routes().derive(withOptionalPrincipal(auth)).bind(refundOrder, authorize(orderPolicies)('order.refund', ({ params }, ctx) => load(params.id), (_input, { order }) => refund(order)))`.
5. The loader returns `null` for a missing row. It may check workspace membership; the policy never queries.

```ts
import { os } from '@orpc/server';
import { z } from 'zod';

import type { AnyPrincipal } from '@arki/auth';
import { definePolicies } from '@arki/auth';
import { guards } from '@arki/auth/orpc';

type Insight = { readonly id: string; readonly userId: string };
type RequestContext = {
  readonly principal: AnyPrincipal | null;
  readonly insights: { byId(id: string): Promise<Insight | null> };
};

const insightPolicies = definePolicies<{ insight: Insight }>()({
  insight: { view: ({ principal, insight }) => insight.userId === principal.user.id, dismiss: () => true },
});
const { can } = guards<RequestContext>();

export const dismiss = os
  .$context<RequestContext>()
  .$meta<{ policy?: string }>({})
  .meta({ policy: 'insight.dismiss' })
  .input(z.object({ insightId: z.string() }))
  .use(can(insightPolicies)('insight.dismiss', ({ insightId }, { insights }) => insights.byId(insightId)))
  .handler(({ context }) => ({ dismissed: context.insight.id }));
```

### Expose a user column

1. Add the column to `columns.user` in `createAuthTables`.
2. Add its name to `user.fields` in the definition. Add it to `user.signUpFields` only if a client may set it at sign-up.
3. Read it as `principal.user.<name>`. Its type is the column's type.

A name that is not a column does not compile, and throws `ARKI_AUTH_E001` at boot for untyped callers. A column you do not list never reaches the principal or the client.

### Test code that needs a signed-in user

1. `testAuth(definition, { tables })` from `@arki/auth/testing` builds the real engine on an in-memory PGlite, with mail in a sink.
2. `actingAs(auth, { email, ...columns })` makes a real session and returns headers that carry it.
3. `lastMagicLink(mail, email)` or `lastLink(mail, template, email)` reads the link from the latest mail.

```ts run
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
});

const { auth, dispose } = await testAuth(definition, { tables });
try {
  const { headers } = await actingAs(auth, { email: 'alice@notes.test', plan: 'pro' });
  const principal = await auth.principal(headers);
  if (principal?.user.plan !== 'pro') throw new Error(`expected plan "pro", got ${principal?.user.plan}`);
  if (principal.via !== 'cookie') throw new Error(`expected a cookie session, got ${principal.via}`);
} finally {
  await dispose();
}
```

For Playwright, mount `createE2EHandler({ auth, enabled, defaultEmail, password })` from `@arki/auth/testing/tanstack-start`. It answers 404 unless `enabled` is `true`, and only signs in `.test` addresses. In each backend, keep one test that calls `assertAuthBoots(() => import('../infra/auth'))` from `@arki/auth/testing/production-boot`.

### Move an app from the old API

Follow [the migration guide](migration.md). It maps every old name to the new one and lists the per-app steps.

## Rules that bite

- Never import `better-auth` in app code. Use `auth.principal`, `auth.sessions` and the guards.
- Never cast a session user (`user.id as UserId`, `user as UserModel`). The principal is already typed from the table.
- The table makes every id. The engine runs with `generateId: false`, so an id column needs a `$defaultFn` (an `@arki/auth/ids` factory has one).
- Production refuses `rateLimit: false` and a missing `rateLimit`. Tests get `rateLimit: false` from `testAuth`.
- The origin and CSRF checks are always on, also under `NODE_ENV=test`. Requests a test sends to `auth.handler` carry an `origin` header equal to the app URL, as a browser's do.
- A magic link to an unknown email signs that person up. Set `magicLink: { signUp: false }` for sign-in-only links; the request still answers 200 and the link is refused when it is used.
- A failed verify mail at password sign-up is logged by the engine, not returned as `ARKI_AUTH_E006`. Asking for the mail again returns `E006`.
- `workspaces` needs `Session.activeOrganizationId` and `Session.activeTeamId` columns (`ARKI_AUTH_E007`). `principal.workspace` is the selection, not proof of membership.
- `expo` is `false` by default. Native apps set `expo: true`.
- A policy never gets the input and never queries. Input rules go in the schema; membership checks go in the loader.
- `can` needs the same policy name in the contract meta (`ARKI_AUTH_E008`). Someone else's row answers `NOT_FOUND` with no auth code, on purpose.
- Events are observers. They never change the response. Only `beforeUserCreate` can refuse, by throwing an `AuthError`.

## Errors

| Code             | Meaning                                                                                                                | What to do                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ARKI_AUTH_E001` | Bad configuration: unknown method or field, missing provider keys, bad duration, no limiter store in production. Boot. | Fix the definition or the bindings. The message names the field.                          |
| `ARKI_AUTH_E002` | Secret missing or shorter than 32 characters in production. Boot.                                                      | Set `AUTH_SECRET` to 32+ random characters.                                               |
| `ARKI_AUTH_E003` | A method sends mail and no mailer is bound. Boot.                                                                      | Add the `mail` plugin (`@arki/mail/dot`) or pass `mail`.                                  |
| `ARKI_AUTH_E004` | The engine's user lacks an exposed column. 500.                                                                        | Check `user.fields` against the table and the database.                                   |
| `ARKI_AUTH_E005` | A testing helper ran with `production: true`. 500.                                                                     | Never mount test helpers in production.                                                   |
| `ARKI_AUTH_E006` | The mailer failed to send an auth mail. 500 with a generic message.                                                    | Check the mail transport. The user may ask again.                                         |
| `ARKI_AUTH_E007` | `workspaces` is on without its tables or session columns. Boot.                                                        | Add `createWorkspaceTables` and the two session columns.                                  |
| `ARKI_AUTH_E008` | `can` checks a policy the procedure's contract meta does not name. 500, a bug.                                         | Add `.meta({ policy: '<group>.<action>' })` to the contract, with the same name as `can`. |
| `ARKI_AUTH_E401` | No principal, or a cookie and a bearer token together. 401.                                                            | Sign in. Send one credential per request.                                                 |
| `ARKI_AUTH_E403` | `role()` or `verified` refused. 403.                                                                                   | Expected for users without the role or a verified email.                                  |
| `ARKI_AUTH_E429` | The rate limiter refused. 429 with `Retry-After`.                                                                      | Wait the given seconds.                                                                   |
| `ARKI_AUTH_E503` | The rate-limit store failed. 503. The request is refused, never let through.                                           | Check the KV store (Redis).                                                               |

## Verify

```sh
turbo run build typecheck lint test --filter=@arki/auth --force
cd packages/auth && bun run test:docs
cd packages/auth && bun run test:runtimes
bun run layers
dot explain --json | jq .data.services   # in an app using @arki/auth/dot: lists auth, needing db and mail
dot doctor --json | jq .data             # in that app: no missing db or mail service
```
