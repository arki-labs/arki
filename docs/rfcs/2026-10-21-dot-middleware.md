# RFC: one way to define middleware in Dot

- Date: 2026-10-21 (revised 2026-10-22)
- Status: Proposed. Founder decisions D1–D10 taken. Steps 1 (oRPC) and 2 (HTTP, queue, schedule, CLI) built; steps 3–6 open.
- Designer: Fable (survey, design, two placement passes, `around` check). File references come from those passes; recheck them when a step starts.

## 1. The shape in one sentence

**A step and an around are plain functions, written once. Each transport package attaches them with its own `step()` and `around()`. Dot handler events stay for app-wide watching.**

## 2. Why

Today "middleware" means four different things in four packages:

| Where | Today | Shape |
|---|---|---|
| RPC | oRPC `.use()`, plus Dot's `needsMiddleware` (`bind`) and `errorCaptureMiddleware` (`packages/dot/src/orpc.ts`) | oRPC onion |
| Auth | `guards()` for oRPC, `withPrincipal` deriver and `authorize` wrapper for HTTP (`packages/auth/src/orpc.ts`, `http.ts`) | three versions of "require a principal" over one core (`requirePrincipal` / `checkPrincipal` / `authorizePolicy`) |
| HTTP | `routes().derive(key, fn)` (typed) and `http({ middleware })` fetch wrappers (untyped) (`packages/http/src/derive.ts`, `engine.ts`) | `(req, ctx) => V \| Failure` |
| Queue | tRPC-style `ctx/next` middleware; timing, logging, error and validation middlewares (`packages/queue/src/types/middleware.ts`, `src/middleware/*`) | onion |

Schedules and CLI commands have no wrapping. Units have lifecycle hooks, which are not middleware and stay as they are.

So an app writes `authed` up to three times, and timing and error code exist in three copies.

## 3. The pieces

| Piece | What it is | Examples | Sees the result? |
|---|---|---|---|
| **Step** | `(ctx: In) => object \| Failure`, sync or async. Runs before the handler. Adds the keys of the object it returns, or refuses the call. | `authed`, `admin`, `asActor`, `principalFromHeaders` | No |
| **Around** | `<T>(ctx: In, next: () => Promise<T>) => Promise<T>`. Wraps everything declared after it. | transaction, retry, span, timeout, per-procedure opt-in | No (`T` is never inspected) |
| **Handler events** | Dot emits `start` / `end` / `fail` with `{ kind, feature, name }` for every handler. Read-only. | app-wide metrics, error reporting, logging | Watches only |
| **Native middleware** | Each transport's own. Kept. | caching, response rewriting | Yes |
| **Validate** | Schemas (`.input()`, contracts), as today. | | |

Nothing is shared at runtime, so nothing needs a home. A step's types come from its own function: `SuccessOf` and `FailureOf` from `@arki/failure`, which every transport already depends on.

## 4. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | What a step is | **A plain function.** No `derive` constructor (2026-10-22, replacing "`derive`"). |
| D2 | How a step adds to the context | **It returns an object.** The keyed shortcut `derive('principal', fn)` is dropped: write `isFailure(p) ? p : { principal: p }`. |
| D3 | How a piece attaches | **Explicit adapters**, one per transport. Every `.use(guard)` call site changes. |
| D4 | Watching every handler | **Dot handler events** for app-wide concerns. |
| D5 | Adapter names | **`step()` and `around()`**, exported by each transport package (`@arki/dot/orpc`, `@arki/http`, `@arki/queue`). The import path names the transport. |
| D6 | `http({ middleware })` fetch wrappers (CORS, tracking) | **Leave as is.** |
| D7 | Schedules and CLI commands | **Yes**: `with: [...]` takes steps and arounds on `@arki/schedule` schedules and `@arki/cli` commands. |
| D8 | Where `derive` / `Step` live | **Nowhere.** Not `@arki/dot` (cli cycle; `arki-layers` L003 for schedule and auth), not `@arki/failure/step` (founder), not a new package (not needed once a step is a plain function). |
| D9 | Wrapping that does not inspect the result | **`around`**, transport-neutral (2026-10-22). Events cannot run a handler in a transaction or retry it. |
| D10 | What an around sees when the call fails with a `Failure` (a step refuses, or the handler returns one) | **A value** (2026-10-22): `next()` resolves to the `Failure`; an around that must roll back checks `isFailure`. A thrown error still rejects `next()`. oRPC is the exception: there a refusal *is* a thrown `ORPCError`, so `next()` rejects. |

## 5. API sketch

```ts
// apps/<app>/backend/src/core/middleware.ts — written once, no Arki import needed
export const authed = (ctx: { principal: Principal | null }) =>
  ctx.principal === null ? AuthenticationRequired() : { principal: ctx.principal };
export const admin = (ctx: { principal: Principal }) => (isAdminEmail(ctx.principal.user.email) ? {} : AccessDenied());
export const inTransaction = <T>(ctx: { db: Db }, next: () => Promise<T>) => ctx.db.transaction(next);

// RPC — step / around from '@arki/dot/orpc'
impl.refund.use(step(authed)).use(step(admin)).use(around(inTransaction)).handler(({ context }) => …);
// HTTP — step / around from '@arki/http'
routes().use(step(principalFromHeaders(auth))).use(step(authed)).use(around(inTransaction));
// queue job — step / around from '@arki/queue'
q.job('refund').use(step(actorFromData)).use(around(inTransaction)).handler((data, ctx) => ctx.principal);
// schedule and CLI command — functions listed directly
schedule('nightly-report', { cron: '0 3 * * *', with: [asSystem, inTransaction], handler: (services, ctx) => … });
defineCommand({ name: 'purge', with: [asOperator], run: ctx => ctx.principal });
```

The HTTP, queue, schedule and CLI shapes are indicative; each follows its package as it is.

## 6. Typing

- A step's input is its parameter type, written once. What it adds is `SuccessOf<fn>`, which must be an object; what it refuses with is `FailureOf<fn>`. Nothing is restated.
- An around is generic in `T`, so it cannot change the result, and the context type after it equals the type before it.
- RPC `step`: returns `StepMiddleware<In, Added, Refused>`, a generic function shaped like an oRPC middleware. oRPC checks `IntersectPick` at the `.use()` call, where the types are concrete. Its `errors` parameter is `DeclaredErrors<Refused>`: oRPC passes the procedure's whole error map in, so an undeclared code is a compile error. A refusal throws the declared `ORPCError` (`rpcError` from `@arki/failure/orpc`).
- RPC `around`: `next()` returns oRPC's `MiddlewareResult`, which becomes the around's `T`. Typed body, no seam.
- HTTP: a refusal short-circuits into the wire envelope (existing path in `bundle.ts`). Queue: a refusal becomes the job outcome. Schedule and CLI: a refusal is the run's failure.
- Inside an around, a refusal is a value (D10), except on oRPC.
- In `with: [...]` lists the element type is `Step | Around`. The runtime tells them apart by `fn.length >= 2`: an around must declare `next` to call it, and a step with a second required parameter fails the step type.
- Order is declaration order, onion style. A step sees every key added before it. An around wraps everything after it: `[authed, inTransaction, loadAccount]` runs `loadAccount` inside the transaction.
- `bind(logic)` stays Dot's own oRPC middleware.

## 7. What goes, what comes

Goes: queue's `src/middleware/*` (timing, logging, error handling, validation); `errorCaptureMiddleware` (becomes a handler-event observer); `guards()` in `@arki/auth/orpc` (`assert*` helpers stay); `withPrincipal` and `authorize` in `@arki/auth/http` (`authFailureHeaders` stays); `@arki/http`'s keyed `derive(key, fn)`.

Comes: `step` and `around` in `@arki/dot/orpc`, `@arki/http` and `@arki/queue`; `with: [...]` on schedules and `@arki/cli` commands; plain-function core steps in `@arki/auth` (`authed`, `verified`, `role`, `can`, `principalFromHeaders`); handler events on Dot's observer; `rpcError` in `@arki/failure/orpc`.

Migration in `apps/*/backend/src` (Fable's count, non-test files): `guards<` 24, ad-hoc `.middleware(` 25, job `.use(` 13, HTTP 1, plus every `.use(guard)` call site.

## 8. Plan

1. **oRPC** — done: `step`, `around`, `rpcError`, type and runtime tests.
2. **HTTP, queue, schedule, CLI** — done: see § 11.
3. Handler events in Dot; move error capture, timing and logging onto them.
4. Auth core steps as plain functions; delete `guards()`, `withPrincipal`, `authorize`.
5. Migrate apps, one app per commit. Novelette's legacy `publicProcedure` / `protectedProcedure` go with its move to `defineFeature`.
6. Docs: `packages/dot/docs/di.md`, `@arki/auth`, `@arki/http`, `@arki/queue`, `@arki/schedule`, `@arki/cli` READMEs; changesets (0.x: minor).

## 9. Risks

- One `Failure` means several refusals (thrown RPC error, HTTP envelope, job outcome, run failure). Each needs a test and a doc line.
- The `with: [...]` runtime split by `fn.length` relies on an around declaring `next`. A test pins it per package.
- Long `.use` chains can still hit TS7056; unchanged from today.

## 10. Step 1 result (oRPC)

- `packages/dot/src/orpc.ts`: `step`, `around`, `StepMiddleware`, `AroundMiddleware`. No cast at any call site. `step`'s body is written against `Context` behind a typed overload (`SuccessOf` of a generic `R` does not narrow under `isFailure`), the same seam as `errorMap` in `@arki/failure`. `around` has a typed body.
- `@arki/failure/orpc`: `rpcError(failure, errors)`, the declared `ORPCError` for a failure in hand. `orThrowRpc` shares its private helper.
- Tests: `src/tests/middleware.test-d.ts` (exact handler context, chained steps, async step, around keeps the context, inline around, contract first; six `@ts-expect-error` cases, each checked to fail for the intended reason) and `src/tests/middleware.test.ts` (declared 401/403 with `defined: true`, handler not run on refusal; around wraps later steps and the handler, passes the result through, sees refusals and handler errors).
- A wrong `.use(step(fn))` now reports `StepMiddleware<{ principal: … }, …> is not assignable…`: readable at the first line.
- The first spike (a `derive` constructor and a `Step` type in `src/middleware.ts`, c922bf69cd) was replaced by plain functions.

## 11. Step 2 result (HTTP, queue, schedule, CLI)

- `@arki/http` (`src/middleware.ts`, `bundle.ts`, `engine.ts`): `step`, `around`, attached with `routes().use(...)` (`.use` was free on the bundle). Steps and arounds share the bundle's ordered stage list with keyed derivers, so declaration order holds; they also run on `rpc()` mounts. A step refusal goes through the same `failureResponse` as a derive refusal (a test compares the bytes); a step has no `failureHeaders` yet. The step's failures join the bundle's failures, so `bind` (via `CoversFailures`) rejects a route that does not declare them. Routes with no stages keep the synchronous fast path. The engine now lets handler errors propagate to its callers' `.catch(toErrorResponse)`, so an around sees them. The keyed `derive(key, fn)` stays until the founder decides (§ 7).
- `@arki/queue` (`src/step.ts`, `job-builder.ts`, `types/builder.ts`): `step`, `around` adapt to job middleware through typed `.use()` overloads on `q.job`. A single generic middleware type fell back to its constraint and let mismatches compile, so overloads it is. A refusal is the job outcome through the returned-failure path (retried only if the job's backoff says so). `src/middleware/*` untouched (step 3).
- `@arki/schedule` (`src/with.ts`, `index.ts`): `with: [...]` on `defineSchedule` and the builder's `define`, folded inside `defineSchedule`, so `runtime.ts` is unchanged and a schedule without `with` runs as before. A refusal is the handler's value, recorded as `refused`.
- `@arki/cli` (`src/with.ts`, `command.ts`, `cli.ts`): `with: [...]` on `defineCommand`; it wraps `preview` too (same context type), so `--dry-run` refuses like a real run. A refusal takes the same path as a failure returned from `run`: same exit code, text and JSON envelope.
- `with` typing (schedule and CLI): each element is checked against the base context plus everything listed before it; the handler sees exactly the base plus every step's additions. An inline around must write its own `<T>`: `next` is not contextually typed because the element type is a union. `defineSchedule<Ctx>({ with })` with explicit type arguments does not take `with`; use `initSchedule.context<Ctx>().create().define`.
- The `fn.length >= 2` split is pinned by tests in both packages, including the trap: a default or rest parameter on `next` makes an around run as a step.
- Every `@ts-expect-error` was checked to fail for the intended reason.

