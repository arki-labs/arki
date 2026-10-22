# Steps and arounds

Arki has one way to wrap a handler. You write a **step** or an **around** once,
as a plain function. Each transport attaches it with its own `step()` and
`around()`. Dot's **handler events** watch every handler the app mounts, for
app-wide logging and error reports.

This page covers oRPC procedures, HTTP routes, queue jobs, schedules and CLI
commands. The same function works on all of them.

## The five pieces

Five pieces wrap or watch a handler. Most code needs only the first two.

- A **step** runs before the handler. It reads the context and returns an
  object, whose keys join the context. Or it returns a failure, and the call
  is refused.
- An **around** wraps everything declared after it, plus the handler. Use it
  for a transaction, a retry, a span or a timeout.
- **Handler events** tell Dot's lifecycle observers that a handler started,
  completed or failed. They only watch.
- **Native middleware** is each transport's own (oRPC middleware, an
  `http({ middleware })` fetch wrapper). It stays for what needs to read or
  rewrite the result, such as caching.
- **Validation** stays with schemas: `.input(schema)` and contracts.

| Piece                 | What it is                                                                                            | Examples                                  | Sees the result?            |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------- |
| **Step**              | `(ctx: In) => object \| Failure`, sync or async. Runs before the handler. Adds keys, or refuses.      | `authed`, `admin`, `principalFromHeaders` | No                          |
| **Around**            | `<T>(ctx: In, next: () => Promise<T>) => Promise<T>`. Wraps everything declared after it.             | transaction, retry, span, timeout         | No (`T` is never inspected) |
| **Handler events**    | `starting` / `completed` / `failed` with `{ transport, feature, name }` for every handler Dot mounts. | app-wide metrics, error reports, logging  | Watches only                |
| **Native middleware** | Each transport's own. Kept.                                                                           | caching, response rewriting, CORS         | Yes                         |
| **Validation**        | Schemas: `.input()`, contracts.                                                                       |                                           |                             |

## A step and an around

A step's parameter is the least context it reads. Its return is what it adds.
An around takes the context and `next`, and returns what `next` returns.

```ts
import { os } from '@orpc/server';

import { around, step } from '@arki/dot/orpc';
import { defineFailure } from '@arki/failure';
import { errorMap } from '@arki/failure/orpc';

// Stand-ins for your own types.
type Principal = { readonly user: { readonly id: string; readonly email: string } };
type Db = { transaction<T>(work: () => Promise<T>): Promise<T> };
type RequestContext = { readonly principal: Principal | null; readonly db: Db };

const SignInRequired = defineFailure('shop.sign_in_required', { status: 401, message: 'Sign in to continue.' });
const NotAdmin = defineFailure('shop.not_admin', { status: 403, message: 'Admins only.' });

// core/middleware.ts: written once, no transport import.
export const authed = (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
export const admin = (ctx: { readonly principal: Principal }) =>
  ctx.principal.user.email.endsWith('@shop.test') ? { isAdmin: true as const } : NotAdmin();
export const inTransaction = <T>(ctx: { readonly db: Db }, next: () => Promise<T>) => ctx.db.transaction(next);

// An oRPC procedure attaches them with `step()` and `around()` from `@arki/dot/orpc`.
export const refund = os
  .$context<RequestContext>()
  .errors(errorMap(SignInRequired, NotAdmin))
  .use(step(authed))
  .use(step(admin))
  .use(around(inTransaction))
  .handler(({ context }) => ({ refundedBy: context.principal.user.id, isAdmin: context.isAdmin }));
```

`admin` reads `principal` as non-null, because `authed` ran first and narrowed
it. The handler sees `principal`, `isAdmin` and `db`, all typed.

The functions import no transport. Each transport has its own adapter, and the
import path names the transport:

| Transport   | Attach                                                     | Import from      |
| ----------- | ---------------------------------------------------------- | ---------------- |
| oRPC        | `impl.refund.use(step(authed)).use(around(inTransaction))` | `@arki/dot/orpc` |
| HTTP        | `routes().use(step(authed)).use(around(inTransaction))`    | `@arki/http`     |
| Queue job   | `q.job.use(step(authed)).use(around(inTransaction))`       | `@arki/queue`    |
| Schedule    | `defineSchedule({ …, with: [asSystem, inTransaction] })`   | `@arki/schedule` |
| CLI command | `defineCommand({ …, with: [asOperator], run })`            | `@arki/cli`      |

Schedules and commands take the functions directly in `with: [...]`. There is
no adapter to import. The same functions on all four kinds of transport:

```ts skip="spans @arki/http, @arki/queue, @arki/schedule and @arki/cli, which @arki/dot does not depend on"
import { defineCommand } from '@arki/cli';
import { around as rpcAround, step as rpcStep } from '@arki/dot/orpc';
import { around as httpAround, step as httpStep, routes } from '@arki/http';
import { around as jobAround, step as jobStep } from '@arki/queue';
import { defineSchedule } from '@arki/schedule';

import { asOperator, asSystem, authed, inTransaction } from './core/middleware.ts';

impl.refund
  .use(rpcStep(authed))
  .use(rpcAround(inTransaction))
  .handler(({ context }) => refund(context));
routes()
  .use(httpStep(principalFromHeaders(auth)))
  .use(httpStep(authed))
  .use(httpAround(inTransaction));
q.job
  .use(jobStep(authed))
  .use(jobAround(inTransaction))
  .name('refund.v1')
  .handler((data, ctx) => ctx.principal);
defineSchedule({
  name: 'nightly-report',
  cron: '0 3 * * *',
  with: [asSystem, inTransaction],
  handler: ctx => report(ctx),
});
defineCommand({ describe: 'Purge old carts', with: [asOperator], run: ctx => purge(ctx.operator) });
```

In a `with: [...]` list, the runtime tells an around from a step by
`fn.length >= 2`. Declare `next` as a plain second parameter: no default value,
no rest parameter. Otherwise the around runs as a step.

## Order is the onion

Order is declaration order. A step sees every key added before it. An around
wraps everything declared after it: later steps and the handler.

```text
with: [authed, inTransaction, loadAccount]

  authed ─────────────────────────────▶ adds principal (or refuses)
  inTransaction ┌───────────────────────────────────────┐
                │  loadAccount ──▶ adds account          │
                │  handler     ──▶ runs with principal,  │
                │                  account, db            │
                └──── commit, or roll back on a throw ──┘
```

So `loadAccount` runs inside the transaction, and `authed` does not. Move
`inTransaction` first and the sign-in check runs inside it too. Pick the order
on purpose; the types will not pick it for you.

## What a refusal becomes

A step refuses by returning a `Failure`. Each transport turns that one value
into its own kind of "no". The handler never runs.

| Transport   | A refusal becomes                                                                                                                                   | Inside an around, `next()`…        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| oRPC        | the declared `ORPCError`, thrown (`rpcError` from `@arki/failure/orpc`), with `defined: true`                                                       | rejects with that `ORPCError`      |
| HTTP        | the coded failure envelope, the same bytes as a failure the handler returns; `step(fn, { failureHeaders })` adds headers such as `www-authenticate` | resolves to the refusal `Response` |
| Queue job   | the job's outcome, as if the handler had returned it; retried only if the job's backoff says so                                                     | resolves to the `Failure`          |
| Schedule    | a run recorded as `refused`, with the failure                                                                                                       | resolves to the `Failure`          |
| CLI command | the command's failure: same exit code, text and JSON as a failure returned from `run` (also for `preview` and `--dry-run`)                          | resolves to the `Failure`          |

Outside oRPC, a refusal is a value. Nothing throws, so nothing rolls back on
its own. An around that must undo work on a refusal checks `isFailure` on the
result (on HTTP, the refusal's status on the `Response`). A thrown error still
rejects `next()` on every transport.

oRPC is the exception. Its middleware chain has no channel for a returned
failure: the only way to reach the client as a typed error is to throw the
declared `ORPCError`. So on oRPC a refusal rejects `next()`, and an around sees
it as a throw (decision D10 below).

## Typing rules

- **A step's failures must be declared.** On oRPC the procedure must list them
  (the contract's errors, or `.errors(errorMap(...))`); otherwise `.use(step(fn))`
  does not compile. On HTTP every route bound after the step must declare them.
  The types come from the function itself: `SuccessOf` and `FailureOf` from
  `@arki/failure`. Nothing is restated.
- **Never return `{}` from a step.** TypeScript folds `{} | Failure` into `{}`,
  so the failure drops out of the type. The route then need not declare it, and
  the compiler no longer checks that refusal. Return a non-empty object instead:

  ```ts skip="shows the mistake next to the fix"
  const admin = (ctx: { principal: Principal }) => (isAdmin(ctx.principal) ? {} : NotAdmin()); // type: {}
  const admin = (ctx: { principal: Principal }) => (isAdmin(ctx.principal) ? { isAdmin: true as const } : NotAdmin());
  ```

- **An around cannot change the result.** It is generic in `T`, so it can only
  return what `next()` gave it. It adds nothing to the context either: the type
  after it equals the type before it.
- **A step returns an object.** A string or a number does not fit the step
  type. Wrap it: `{ tenant: id }`.
- **Inline elements in `with: [...]` annotate every parameter** (an around also
  its `<T>`). TypeScript cannot infer a tuple whose elements depend on each
  other. Named functions, the normal style, need nothing extra.

## Watching every handler: handler events

Steps and arounds belong to one handler. For something every handler needs,
such as logging or error reports, register an observer once on the app:

```ts
import { defineApp, logHandlers, reportErrors } from '@arki/dot';

// Stand-in for your tracker's capture call.
const captured: unknown[] = [];
const captureException = (error: unknown, tags: Record<string, string>) => {
  captured.push({ error, tags });
};

export const app = defineApp('shop', {
  observers: [
    reportErrors({
      report: (error, { transport, feature, name }) => captureException(error, { transport, feature, name }),
    }),
    logHandlers(),
  ],
});
```

- `reportErrors({ report })` calls `report` only for `failed` events: the
  handler threw. A refusal, a returned `Failure` or an oRPC error below 500 is
  `completed` with `outcome: 'refused'`. That is traffic, not an incident.
- `logHandlers()` writes one DEBUG line per call on `arki:dot:handlers`, such
  as `rpc digest.preview ok 12ms`. With no observer, a handler call costs
  nothing extra.

Events only come from handlers that Dot mounts:

| Transport  | Emits when                                                             | `name`             |
| ---------- | ---------------------------------------------------------------------- | ------------------ |
| `rpc`      | the procedure is mounted through `bind(logic)`                         | the procedure path |
| `http`     | a route or `rpc()` mount Dot serves through `@arki/http/dot`           | `METHOD /path`     |
| `job`      | a job a feature declares with `jobs()` from `@arki/queue/dot`          | the job name       |
| `schedule` | any schedule the app runs (feature-owned, feature-declared, app-level) | the schedule name  |

A procedure built from plain `os`, without `bind`, emits nothing. CLI commands
emit nothing either: Dot does not mount them. The event fields are in
[Observability: handler events](observability.md#handler-events).

## The auth steps

`@arki/auth` ships the common checks as plain steps. Each reads
`ctx.principal` and keeps your app's own principal type.

| Step         | Passes when                    | Refuses with                                                    |
| ------------ | ------------------------------ | --------------------------------------------------------------- |
| `authed`     | someone is signed in           | `auth.unauthenticated` (401)                                    |
| `verified`   | signed in, email verified      | 401 for a guest, `auth.forbidden` (403) for an unverified email |
| `role(name)` | signed in with the role `name` | 401 for a guest, 403 without the role                           |

```ts skip="@arki/auth is not a dependency of @arki/dot"
import { authed, role } from '@arki/auth';
import { authFailureHeaders, principalFromHeaders } from '@arki/auth/http';
import { step } from '@arki/dot/orpc';
import { step as httpStep, routes } from '@arki/http';

impl.profile.use(step(authed)).handler(({ context }) => context.principal.user.id);
impl.audit.use(step(role('auditor'))).handler(({ context }) => listAudits(context.principal));

routes()
  .use(httpStep(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))
  .use(httpStep(authed, { failureHeaders: authFailureHeaders }));
```

On HTTP, `principalFromHeaders(auth)` adds `principal` (`null` for a guest)
from the request's credentials. Policy checks keep their per-transport
wrappers (`can` in `@arki/auth/orpc`, `authorize` in `@arki/auth/http`):
a policy loads its subject from the input, and a step sees only the context.

## Why we chose this

Before, "middleware" meant four things in four packages: oRPC middleware,
`guards()` and `withPrincipal` in auth, `routes().derive()` in HTTP, and a
tRPC-style onion in the queue. An app wrote `authed` up to three times. These
decisions made it one thing.

| #   | Question                                   | Decision and reason                                                                                                                                                                                              |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What a step is                             | **A plain function.** It needs no Arki import, and its types come from its own signature.                                                                                                                        |
| D2  | How a step adds to the context             | **It returns an object.** The keyed shortcut `derive('principal', fn)` is gone: write `isFailure(p) ? p : { principal: p }`. One shape, no second way.                                                           |
| D3  | How a piece attaches                       | **One explicit adapter per transport.** Each transport turns a refusal into its own kind of error, so each owns the attaching.                                                                                   |
| D4  | Watching every handler                     | **Dot handler events.** App-wide concerns are registered once, not attached to every handler.                                                                                                                    |
| D5  | Adapter names                              | **`step()` and `around()`** in every transport package. The import path names the transport.                                                                                                                     |
| D6  | `http({ middleware })` fetch wrappers      | **Left as is.** CORS and tracking work on the raw request, outside any route.                                                                                                                                    |
| D7  | Schedules and CLI commands                 | **`with: [...]`** takes steps and arounds. They had no wrapping before.                                                                                                                                          |
| D8  | Where a shared `Step` type lives           | **Nowhere.** `@arki/dot` would make a cycle with `@arki/cli` and break the layer rules for schedule and auth; `@arki/failure/step` was turned down; a new package is not needed once a step is a plain function. |
| D9  | Wrapping that does not read the result     | **`around`**, the same on every transport. An event cannot run a handler inside a transaction or retry it.                                                                                                       |
| D10 | What an around sees on a refusal           | **A value** that `next()` resolves to; check `isFailure`. A throw still rejects. oRPC is the exception: there a refusal is a thrown `ORPCError`.                                                                 |
| D11 | How an event reports an outcome            | **`starting` / `completed` / `failed`**, reused. A refusal is `completed` with `outcome: 'refused'`; `failed` means thrown. An error reporter watches one status.                                                |
| D12 | Names                                      | `transport` on the event, `$handlers` on the kernel context, `reportErrors({ report })` and `logHandlers()`.                                                                                                     |
| D13 | Per-handler logging                        | **Opt-in**, through `logHandlers()`. No observer, no cost.                                                                                                                                                       |
| D14 | Schedules declared outside a feature slice | **They emit too**, as the unit that declared them.                                                                                                                                                               |

Options we turned down:

- **A `derive` constructor** (`derive(fn)` returning a `Step` value). The first
  spike had one. It added an import and a type to learn, and gave nothing a
  plain function does not. It was replaced before anything shipped.
- **A shared home for `Step`** in `@arki/dot`, `@arki/failure/step` or a new
  package. Nothing is shared at runtime, so there is nothing to house (D8).
- **Handler events instead of arounds.** Events only watch. They cannot open a
  transaction around a handler, retry it, or time it out (D9).

The full design and what each step built are in the RFC,
`docs/rfcs/2026-10-21-dot-middleware.md` in the monorepo.
