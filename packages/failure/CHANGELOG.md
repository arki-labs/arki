# @arki/failure

## 0.3.0

### Minor Changes

- 11c5bc2: Keep failure detection total for opaque/revoked objects and inaccessible failure codes. Close discarded-failure escapes through void/comma expressions, erased callbacks/class fields, negative guard branches and bound/call/apply acceptance helpers; existing failure lint configurations now report these unhandled outcomes. Supervise retry observation timing so completed work cannot be retried by a reporting defect. Validate foreign Backoff delays and Clock outcomes against canonical contracts; malformed providers return the existing UnexpectedDefect before more work. Reject invalid static breaker/deadline/capacity options through schema-owned AssertError before engine construction. Preserve exact success/failure identity and public event types; omit unmeasurable duration events.

  No demo impact: standard providers and typed call sites keep their existing contracts. Custom provider requirements and observation limits are documented in the Resilience upgrade guide.

- a905468: One way to write middleware (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, steps 1 and 2):

  - A step is a plain function: `(ctx) => object | Failure`. It reads the least context it needs, adds the keys of the object it returns, or refuses the call with a typed failure.
  - An around is a plain function: `<T>(ctx, next: () => Promise<T>) => Promise<T>`. It wraps everything declared after it and the handler, for a transaction, a retry or a span. It adds nothing to the context.
  - Order is declaration order. A step sees every key added before it.

  Each transport attaches the same functions:

  - `@arki/dot/orpc`: `impl.refund.use(step(authed)).use(around(inTransaction))`. A refusal is thrown as the typed error the procedure declares; a procedure that does not declare the step's failure does not compile.
  - `@arki/http`: `routes().use(step(authed)).use(around(inTransaction))`. A refusal answers with the same coded error envelope as a failure the handler returns; every route bound after the step must declare its failures. `step(fn, { failureHeaders })` adds response headers to a refusal (a `www-authenticate` challenge, say), typed by the step's own failures.
  - `@arki/queue`: `q.job.use(step(actorFromData)).use(around(inTransaction))`. A refusal is the job's outcome, as if the handler had returned it.
  - `@arki/schedule`: `defineSchedule({ …, with: [asSystem, inTransaction], handler })`. A refusal makes the run `refused`.
  - `@arki/cli`: `defineCommand({ …, with: [asOperator], run })`. `with` also wraps `preview`. A refusal is the command's failure: same exit code and error output as a failure returned from `run`.

  In `with: [...]` lists, an around is told from a step by `fn.length >= 2`: declare `next` as a plain second parameter (no default value, no rest parameter).

  Outside oRPC, a refusal reaches an around as the value `next()` resolves to, not as a throw: the `Failure` itself on queue, schedule and CLI, the refusal's `Response` on HTTP. An around that must roll back on a refusal checks `isFailure` on the result (on HTTP, the response status). A thrown error still rejects `next()`.

  `@arki/failure/orpc` adds `rpcError(failure, errors)`: the declared `ORPCError` for a failure already in hand, to throw.

- 1a897f8: Handler events (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 3). Every handler a Dot app mounts — an oRPC procedure through `bind`, an HTTP route or `rpc()` mount, a queue job, a schedule run — now reports to the app's lifecycle observers:

  - A handler event has `kind: 'handler'`, `transport` (`'rpc' | 'http' | 'job' | 'schedule'`), `feature` (the owning unit) and `name` (the oRPC path, `METHOD /path`, the job or schedule name). Its `status` is `starting`, then `completed` (with `durationMs` and `outcome: 'ok' | 'refused'`; a refusal carries its `failure`) or `failed` (a throw, with `error`). A returned failure or a step's refusal is `completed/refused`, never `failed`. On oRPC, a thrown error below 500 is a refusal.
  - `@arki/dot` adds two observers for `defineApp(name, { observers })`: `reportErrors({ report })` calls `report(error, { transport, feature, name })` for every `failed` handler, and `logHandlers()` writes one DEBUG line per handler on `arki:dot:handlers`. With no observer registered, a handler call costs nothing extra.
  - Transport adapters reach the emitter through `handlerObserverOf(services)` from `@arki/dot/feature` (`watching()`, `run(ref, work, outcome?)`); the kernel context carries it as `$handlers`.
  - Breaking: `errorCaptureMiddleware` is removed from `@arki/dot/orpc`. Register `reportErrors({ report })` instead; it keeps the same rule (a 4xx is traffic, anything else is reported).
  - Breaking: `@arki/queue` removes its standard middleware (`timingMiddleware`, `loggingMiddleware`, `errorHandlingMiddleware`, `validationMiddleware` and the other `src/middleware` exports). Timing and logging are `logHandlers()`, error reporting is `reportErrors()`, validation is `.input(schema)`, timeouts are `options.timeoutMs`, and a per-job logger is a `step`.
  - `@arki/failure/orpc`: the `ORPCError` that `rpcError` and `orThrowRpc` throw carries the failure as its `cause`, on the server only (oRPC never sends `cause` to the client).

- cac4bc6: `defineFailure` no longer names the schema library in its type. A definition's `dataSchema` is typed `StandardSchemaV1<Input, Output>` (new `PortableSchema<Schema>`), so an exported failure stops printing `z.ZodObject<…>` into its package's `.d.ts` and consumers no longer depend on Zod's types. Breaking for code that called Zod methods on `definition.dataSchema` (`.safeParse`, `.shape`): keep the Zod schema in its own constant, or use `parse` / `is` from `@arki/schema`.

  `@arki/schedule`: classifies lock provider codes with its own `lockCodeSchema` instead of Zod methods on `ScheduleLockFailed.dataSchema`.

### Patch Changes

- 11c5bc2: Complete public error summaries and remediation metadata. The source error index now follows canonical factory aliases, checks duplicate original codes across packages, and enforces documentation for private libraries too. Runtime behavior and failure data are unchanged.

  No demo impact: this changes error documentation and repository checks only.

- 49517e2: The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

  `@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

  `@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.

## 0.2.0

### Minor Changes

- 6601242: Breaking: `assertNever` is renamed `unreachable`, with no alias. Its default message no longer contains the value (it could leak a secret). The error code stays `ARKI_FAILURE_E004`. New: `invariant(condition, message?)` asserts a condition and throws `FailureError` `ARKI_FAILURE_E008`; the message may be a function, built only on failure.
- 2000a7e: Fix: `is`, `assert` and `ensure` now answer about a value that is itself a failure. Before, `is(failureValue, recordSchema)` returned `false` for an invalid-input failure and threw for any other failure, because `parse` returns a failure-valued output and a rejection the same way. `@arki/failure/schema` now exports `executeSchema`, which runs a schema once without unwrapping (`{ value }` or a failure), and the throwing channel is built on it.

## 0.1.0

### Minor Changes

- 57313a4: Cursor encoding and decoding return canonical failures. Database pagination
  preserves those outcomes before building SQL or returning a page. Check codec
  results and declare the original cursor failures at RPC boundaries.

  Failure lint rules now catch discarded callback returns, nested aggregate and
  iterator results, and blind acceptance through aliases or generic failure guards.
  Handle each outcome or forward it to its owner.
  Browser contract linting admits canonical failure definitions while keeping
  exception bridges in implementations.
  The exported lock conformance suite now checks each queued task's acquisition
  outcome before accepting its completion counts.

  Dot acquires telemetry instruments inside guarded execution, so importing before
  SDK setup works and broken reporters cannot replace application outcomes.

- 232d3e8: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- 3f6d39f: New `stoppable(value, stoppedBy?)` builds a `Stoppable<Value, Failures>`, so a partial-success function's return type is inferred: return `stoppable(value)` when the work finished and `stoppable(value, failure)` when a failure stopped it, with no `Promise<Stoppable<...>>` annotation. It returns a shallow copy of `value` and adds the `stoppedBy` key only when a failure is given.
- 7f9b4bb: Fixes from the first real app that used `@arki/failure`.

  - `@arki/failure/orpc` is safe in the browser. It imports `ORPCError` from `@orpc/client` instead of `@orpc/server`. It is the same class, so typed errors still reach the client as `defined: true`. The optional peer dependency is now `@orpc/client`.
  - The lint config `configs.recommended` covers TypeScript files only (`**/*.{ts,tsx,mts,cts}`). The `must-use` rule needs type information, so it no longer crashes on plain `.js` files such as `eslint.config.js`.
  - `match` takes no `ok` handler when the value can only be a failure, as on the client after `reviveRpcError`. Then the handlers are one per failure code. Passing `ok` there is a type error, like any stale handler. A value that can be a success still needs `ok`.
  - The README shows three patterns: a function that returns nothing or a failure, a partial success that keeps its progress with the failure inside the result, and how to choose a status (422 when an upstream service refuses us, 401 only for "not signed in", 503 when an upstream is down).

- 86efafc: New `Stoppable<Value, Failures>` type for a partial success: `Value & { readonly stoppedBy?: Failures }`. Callers read `result.stoppedBy` directly, with no `'stoppedBy' in result` check. `orThrowRpc` (`@arki/failure/orpc`) takes an optional third argument: `orThrowRpc(value, errors, success)` throws the failure as before, or returns `success`. It is for a usecase that returns nothing or a failure, such as `return orThrowRpc(await disconnect(id), errors, { success: true })`. The two-argument form is unchanged. The README gains an "Adopting in an app" section, and "Choosing a status" now says to name an upstream HTTP status `upstreamStatus`.
- d541df1: New package: typed expected failures with no wrapper and no runtime. `defineFailure(code, { data, message, status, remediation })` names a failure once; calling the definition makes a frozen, branded failure value that a function returns like any other value, so its return type is inferred as `Value | Failure<…>` and the compiler makes every caller check. Message templates (`'no post {id}'`) are checked against the data schema. Adds `isFailure` (a promise is a type error), exhaustive `match`, `recover` (partial handling that removes the handled codes from the type), `orThrow` with `UnexpectedFailure`, `attempt` for code that throws, `revive` for failures that went through JSON, `findCause` for cause chains, `partition`, `collect`, `assertNever`, `FailureOf`, `SuccessOf`. Entries: `@arki/failure/orpc` (`errorMap`, and `orThrowRpc(value, errors)`, where a failure the contract does not list is a compile error) and `@arki/failure/eslint` (the `must-use` rule for discarded failures). The data schema is any Standard Schema; the core has no dependencies.
- f6a15d0: Breaking: failure data is typed as the schema's **output**, and the package builds on `@arki/schema`.

  - `StandardSchemaV1` and `SchemaInput` are no longer exported. Import them from `@arki/schema`.
  - `DataOf<Schema>` is the schema's output type, the live value a failure carries. It was the input type, which disagreed with `revive`, which passes the validated output to the definition.
  - `StandardSchemaV1` is now the real spec type, stricter than the old local copy (`validate` must return a Standard Schema result).
  - New dependency: `@arki/schema`.
  - `FailureError` takes an optional fourth argument, `ErrorOptions`.
  - `revive` validates with `@arki/schema`'s `parse`. `ARKI_FAILURE_E006` and `ARKI_FAILURE_E007` now carry the `SchemaError` / `SchemaRunError` as `cause`. A validator that throws is no longer reported as bad data: its `SchemaRunError` (`ARKI_SCHEMA_E002`) passes through.

- 4913009: Security: outside data can no longer pass as a failure. `isFailure` (and `@arki/log`'s failure check) now require the `~failure` brand on the value's prototype and refuse it as an own property. Before, JSON such as `{"~failure": true, "code": "x", "status": 500}` from an API response, queue message or tool result counted as a failure, so boundaries skipped output schemas and answered with an attacker-chosen status or code. Real failures, revived ones and failures from a second copy of the package are still recognised.
- 232d3e8: RPC error maps retain their original failure definitions for exact revival by another contract adapter. Use `rpcFailureDefinitions` to read these references; wire JSON remains unchanged.

  Add reusable browser-safe action contracts, server execution ownership and scoped
  OpenTelemetry helpers. Native RPC/HTTP adapters parse and encode once while
  sharing canonical failures and explicit exposure, principal and approval policies.

  Breaking: HTTP boundaries and auth policies return typed canonical failure values;
  update callers that inspect legacy strings or expect thrown refusals. Retry
  ownership is explicit. MCP adds browser-safe contract annotations and callable
  tools that reuse the gateway's typed native client, preserve canonical failures,
  and enforce access, approval and result budgets. Hosts provide approval authority;
  the full MCP server and durable confirmation store remain separate work.

- 73ef41b: `failure/must-use` is stricter. It now reports a discarded `Promise.all` or `Promise.allSettled` whose items can be failures (the result is an array, so the old check missed it), and `void` is no longer an opt-out: `void (await remove(id))` is reported too. The only deliberate discard left is `// eslint-disable-next-line failure/must-use -- <reason>`. This can break lint in code that used `void` to drop a failure.

  New rule `failure/no-blind-accept`, on in `configs.recommended`. It reports `accept(r)` (or `ctx.accept(r)`) when `r` was not checked by kind: `if (isFailure(r)) accept(r)` and an unchecked `accept(r)` are reported; `if (OutOfStock.is(r)) accept(r)` and `if (OutOfStock.is(r) || Busy.is(r)) accept(r)` pass. The checked call names are set with `names` (default `['accept']`). This can break lint in code that accepts any failure.

- f796e5a: New in `@arki/failure/orpc`: `reviveRpcError(error, definitions)`. On the client, it turns a caught `ORPCError` whose code is one of the definitions back into the live failure, and checks its data with the definition's schema like `revive`. Any other error gives `undefined`, so you rethrow it. The result is typed from the definitions, so frontend code can `match` on failures the same way backend code does.

### Patch Changes

- f43d509: Docs standard: AGENTS.md, an agent guide, llms.txt, CHANGELOG, a tested example, a rewritten README, and `@fix`/`@verify` notes on every error code. The README no longer names a private app.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

## 0.0.0

Not published yet. The first release is 0.1.0, so there is nothing to upgrade from.
