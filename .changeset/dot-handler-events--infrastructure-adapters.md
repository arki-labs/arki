---
'@arki/http': minor
'@arki/queue': minor
'@arki/schedule': minor
---

Handler events (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 3). Every handler a Dot app mounts — an oRPC procedure through `bind`, an HTTP route or `rpc()` mount, a queue job, a schedule run — now reports to the app's lifecycle observers:

- A handler event has `kind: 'handler'`, `transport` (`'rpc' | 'http' | 'job' | 'schedule'`), `feature` (the owning unit) and `name` (the oRPC path, `METHOD /path`, the job or schedule name). Its `status` is `starting`, then `completed` (with `durationMs` and `outcome: 'ok' | 'refused'`; a refusal carries its `failure`) or `failed` (a throw, with `error`). A returned failure or a step's refusal is `completed/refused`, never `failed`. On oRPC, a thrown error below 500 is a refusal.
- `@arki/dot` adds two observers for `defineApp(name, { observers })`: `reportErrors({ report })` calls `report(error, { transport, feature, name })` for every `failed` handler, and `logHandlers()` writes one DEBUG line per handler on `arki:dot:handlers`. With no observer registered, a handler call costs nothing extra.
- Transport adapters reach the emitter through `handlerObserverOf(services)` from `@arki/dot/feature` (`watching()`, `run(ref, work, outcome?)`); the kernel context carries it as `$handlers`.
- Breaking: `errorCaptureMiddleware` is removed from `@arki/dot/orpc`. Register `reportErrors({ report })` instead; it keeps the same rule (a 4xx is traffic, anything else is reported).
- Breaking: `@arki/queue` removes its standard middleware (`timingMiddleware`, `loggingMiddleware`, `errorHandlingMiddleware`, `validationMiddleware` and the other `src/middleware` exports). Timing and logging are `logHandlers()`, error reporting is `reportErrors()`, validation is `.input(schema)`, timeouts are `options.timeoutMs`, and a per-job logger is a `step`.
- `@arki/failure/orpc`: the `ORPCError` that `rpcError` and `orThrowRpc` throw carries the failure as its `cause`, on the server only (oRPC never sends `cause` to the client).
