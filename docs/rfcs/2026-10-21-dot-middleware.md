# RFC: one way to define middleware in Dot

- Date: 2026-10-21
- Status: Proposed. Founder decisions D1–D7 taken 2026-10-21. Step 1 (spike) passed 2026-10-21, not committed; see § 10.
- Designer: Fable (survey + design, two read-only passes). File references below come from those passes and need a recheck when work starts.

## 1. The shape in one sentence

**A context step is written once with `derive`, and an explicit adapter attaches it to an oRPC procedure, an HTTP route bundle or a queue job. Timing, logging, error capture and tracing are not middleware: Dot emits a handler event and apps observe it.**

## 2. Why

Today "middleware" means four different things in four packages:

| Where | Today | Shape |
|---|---|---|
| RPC | oRPC `.use()`, plus Dot's `needsMiddleware` (`bind`) and `errorCaptureMiddleware` (`packages/dot/src/orpc.ts`) | oRPC onion |
| Auth | `guards()` for oRPC, `withPrincipal` deriver and `authorize` wrapper for HTTP (`packages/auth/src/orpc.ts`, `http.ts`) | three versions of "require a principal" over one core (`requirePrincipal` / `checkPrincipal` / `authorizePolicy`) |
| HTTP | `routes().derive(key, fn)` (typed) and `http({ middleware })` fetch wrappers (untyped) (`packages/http/src/derive.ts`, `engine.ts`) | `(req, ctx) => V \| Failure` |
| Queue | tRPC-style `ctx/next` middleware; timing, logging, error and validation middlewares (`packages/queue/src/types/middleware.ts`, `src/middleware/*`) | onion |

Schedules and CLI commands have no wrapping. Units have lifecycle hooks, which are not middleware and stay as they are.

So an app writes `authed` up to three times, and timing/error code exists in three copies.

## 3. Three jobs, one home each

| Job | Examples | Home |
|---|---|---|
| Derive / guard: add to the context, narrow it, or refuse | `authed`, `admin`, `asActor`, `principalFromHeaders` | `derive` from `@arki/dot/middleware` |
| Around: wrap every call | timing, logging, error capture, tracing | Dot handler events on the lifecycle observer |
| Validate | input checks | schemas (`.input()`, contracts), as today |

## 4. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Name of the shared building block | **`derive`** (the word `@arki/http` already uses). |
| D2 | Return shape | **Both**: `derive('principal', fn)` for one value, `derive(fn)` returning an object for several. |
| D3 | How a step attaches | **Explicit adapters**, one per transport. A step is not itself an oRPC middleware. Every `.use(guard)` call site changes. |
| D4 | Around concerns | **Dot handler events** (`start` / `end` / `fail` with `{ kind, feature, name }`). Per-procedure opt-in (Novelette's dev delay) is given up. |
| D5 | Adapter names | **`fromDerive`, exported by each transport package** (`@arki/dot/orpc`, `@arki/http`, `@arki/queue`). The import path names the transport. |
| D6 | `http({ middleware })` fetch wrappers (CORS, tracking) | **Leave as is.** |
| D7 | Steps on schedules and CLI commands | **Yes**: `with: [step]` on schedules and on `@arki/cli` commands. |

## 5. API sketch

```ts
// apps/<app>/backend/src/core/middleware.ts — written once
import { derive } from '@arki/dot/middleware';
import { requirePrincipal } from '@arki/auth';

export const authed = derive('principal', (ctx: { principal: Principal | null }) => requirePrincipal(ctx.principal));
export const admin = derive((ctx: { principal: Principal }) => (isAdminEmail(ctx.principal.user.email) ? {} : AccessDenied()));

// RPC — fromDerive from '@arki/dot/orpc'
implement(contract).$context<RequestContext>().use(bind(logic)).errors(errorMap(AuthenticationRequired)).use(fromDerive(authed));
// HTTP — fromDerive from '@arki/http'
routes().derive(fromDerive(principalFromHeaders(auth))).derive(fromDerive(authed));
// queue job — fromDerive from '@arki/queue'
q.job('refund').use(fromDerive(actorFromData)).use(fromDerive(authed)).handler((data, ctx) => ctx.principal);
// schedule and CLI command — steps listed directly
schedule('nightly-report', { cron: '0 3 * * *', with: [asSystem], handler: (services, ctx) => ctx.principal });
defineCommand({ name: 'purge', with: [asOperator], run: ctx => ctx.principal });
```

## 6. Typing

- `Step<In, Out, F>`. `In` is the parameter type, written once. `Out` is the return type minus `Failure`. `F` is the `Failure` part. Nothing is restated.
- RPC adapter: builds an oRPC middleware whose error map is `ErrorMapOf<F>`. A procedure must declare `F` with `.errors(errorMap(...))`, checked at compile time as `PrincipalGuard` does today. A refusal throws the declared oRPC error.
- HTTP adapter: the context becomes `Ctx & Out`. A refusal short-circuits into the wire envelope (existing path in `bundle.ts`).
- Job adapter: wraps the step as a job middleware. A refusal becomes the job outcome.
- `bind(logic)` stays Dot's own oRPC middleware. Order is declaration order; later steps see earlier keys.
- Each adapter gets a `*.test-d.ts` with a two-way `toEqualTypeOf` on the handler context.

## 7. What goes, what comes

Goes: queue's `src/middleware/*` (timing, logging, error handling, validation); `errorCaptureMiddleware`; `guards()` in `@arki/auth/orpc` (`assert*` helpers stay); `withPrincipal` and `authorize` in `@arki/auth/http` (`authFailureHeaders` stays).

Comes: `@arki/dot/middleware` (`derive`, `Step`); core steps in `@arki/auth` (`authed`, `verified`, `role`, `can`, `principalFromHeaders`); `fromDerive` in `@arki/dot/orpc`, `@arki/http` and `@arki/queue`; `with: [step]` on schedules and `@arki/cli` commands; handler events on Dot's observer.

Migration in `apps/*/backend/src` (Fable's count, non-test files): `guards<` 24, ad-hoc `.middleware(` 25, job `.use(` 13, HTTP 1. With D3, every `.use(guard)` call site also changes (93 `.use(` calls; some are `bind`, which stays).

## 8. Plan

1. **Spike (half a day).** Build `derive` and the RPC adapter only. Prove oRPC's `IntersectPick` holds with no cast, locked by a type test. If it needs a cast, stop and bring it back.
2. HTTP and job adapters, then `with:` on schedules and CLI commands, each with type tests. The exact schedule and command shapes follow `@arki/schedule` and `@arki/cli` as they are; the sketch above is indicative.
3. Handler events in Dot; move timing / logging / error capture onto them.
4. Auth core steps; delete `guards()`, `withPrincipal`, `authorize`.
5. Migrate apps, one app per commit. Novelette's legacy `publicProcedure` / `protectedProcedure` go with its move to `defineFeature`.
6. Docs: `packages/dot/docs/di.md`, `@arki/auth` and `@arki/queue` READMEs, changesets (0.x: minor).

## 9. Risks

- oRPC may not accept a generic `Out` without a cast (step 1 tests this first).
- One `Failure` means three different refusals (thrown RPC error, HTTP envelope, job outcome). Each needs a test and a doc line.
- Long `.use` chains can still hit TS7056; unchanged from today.

## 10. Spike result (step 1)

Passed: `derive` and the oRPC `fromDerive` work with **no cast**.

- `packages/dot/src/middleware.ts`: `derive` (keyed and object forms), `Step`, `StepResult`.
- `packages/dot/src/orpc.ts`: `fromDerive`. It returns a generic function shaped like an oRPC middleware, as `PrincipalGuard` does. oRPC checks `IntersectPick` at the `.use()` call, where the types are concrete. Its `errors` parameter is `DeclaredErrors<F>`: oRPC passes the procedure's whole error map in, so a missing code is a compile error.
- Two changes from § 6 were needed:
  - A step returns a tagged `StepResult` (`{ ok: true, added } | { ok: false, failure }`), not `Out | F`. `Exclude<Out | F, Failure>` does not reduce to `Out` while `Out` is generic.
  - `@arki/failure/orpc` gains `rpcError(failure, errors)`: the declared `ORPCError` for a failure already in hand. `orThrowRpc` now shares its private helper.
- Tests: `src/tests/middleware.test-d.ts` (exact handler context for both forms, chained steps, async step, contract-first; four `@ts-expect-error` cases, each checked to fail for the intended reason) and `src/tests/middleware.test.ts` (declared 401/403 with `defined: true`, handler not run on refusal, keys added).
- Known cost: a refused `.use(fromDerive(step))` gives a long oRPC `MiddlewareOptions` error. Readable at its first line only. Worth a branded error message later, as `ShadowGuard` does for `bind`.
- `@arki/dot/middleware` is not in `package.json` `exports` yet.

