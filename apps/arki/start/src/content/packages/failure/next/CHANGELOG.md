# @arki/failure

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
