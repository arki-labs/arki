# Agent guide: @arki/http

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/index.ts` and `src/contract.ts` win.

## The model

1. A route has two halves. The **contract** is plain data at module scope: method, path, schemas and a stable id. The **binding** is the handler, attached with `routes().bind(contract, handler)`.
2. Any Standard Schema validates input and output (zod, valibot, arktype). Input is checked before the handler. Output is checked on the way out.
3. `buildEngine([bundles])` composes bundles into one `fetch` handler. `listen(engine.fetch, { port })` serves it. Routing is Hono inside. No Hono type is public.
4. Derivers build the request scope (the user, the tenant). They run before the handler. Throwing an `HttpError` from one short-circuits the request.
5. Failures are values or `HttpError`s. Both become a coded envelope: `{ "error": { "code", "message", ... } }`.
6. `@arki/http/dot` is the Dot driver. It mounts the bundles of every feature and drains requests on shutdown.
7. It does not hold state. Idempotency keys use a store you give it.

## Task map

### Add a route

1. Declare the contract in a browser-safe file: `route.get('/orders/:id', { id: 'orders.get', params: { id: z.string() }, output: Order })`.
2. Bind the handler: `routes().bind(getOrder, ({ params }) => usecases.find(params.id))`.
3. Add the bundle to `buildEngine([...])`, or return it from a Dot feature with `endpoints(...)`.
4. Test it with `engine.fetch(new Request(url))`. No socket is needed.

### Return a typed failure

1. Declare the failure with `defineFailure` from `@arki/failure` and list it in the contract `failures`.
2. Return it from the handler. It becomes a response with the failure code.

### Add a deriver

1. Write `derive(key, callback, { failureHeaders })`; return the success value or an inferred canonical failure.
2. List every accumulated deriver failure in each contract's `failures`; `bind` and typed `rpc` mounts reject omitted or partial lists. Failure values never enter successful context fields.
3. Use `failureHeaders` for challenges and retry headers. Handler-owned failures can supply the same callback as the third `bind` argument.
4. Keys must be unique (`ARKI_HTTP_E007`). Each binding runs only the derivers present when it was bound.

### Make a write safe to repeat

1. Pass the same canonical route descriptors to `idempotent({ routes: [writeRoute], ... })`. Each must list all `IDEMPOTENCY_FAILURES`; omitted or partial declarations fail typechecking and configure-time validation.
2. The client sends the same `Idempotency-Key` for every retry of one action. List `IDEMPOTENCY_FAILURES` on that route to infer its refusals.
3. `ResponseCache` owner arguments are `IdempotencyOwnerId`. Restore stored/test strings with `idempotencyOwnerId.schema`; do not restate the brand or cast a string. The middleware generates before hashing or cache acquisition, returning canonical entropy failures through its HTTP bridge.

### Correlate and trace a request

1. Use the inferred `ctx.requestId` (`RequestId`). Every present `x-request-id` is preserved; without one, canonical UUID generation must succeed before bound execution.
2. Configure your OTel SDK and async context manager once at the application entry. The engine and protected idempotency middleware create `http.request` and `http.idempotency` spans automatically.
3. Use `trace.getActiveSpan()` or the application tracer inside a handler/plugin. Built-in attributes contain only response status and failure code. Keep secrets, request bodies and private failure causes out of your attributes.
4. See [the upgrade guide](upgrade-identities.md) for nominal fixtures and the expanded inferred failure tuples.

### Receive a signed webhook

1. Create a scheme from `@arki/http/webhooks` with the sender secrets.
2. Bind the route with the scheme. A bad signature answers 401 before the handler runs.

### Publish OpenAPI

1. Call `toOpenApi(contracts)`. The output is deterministic.
2. A schema with no JSON Schema form throws `ARKI_HTTP_E013`. Wrap it with `withJsonSchema`.

### Call a route from a client

1. Build the client from the same contracts with `@arki/http/client`.
2. Set `timeoutMs`. A timeout returns `RequestTimeout`; client calls also return exact canonical input/network/cancellation/protocol failures.

## Rules that bite

- Match on `error.code`. Never match on the message.
- Output is only as narrow as its schema. A zod object drops undeclared keys. An arktype object keeps them. Never return a whole database row.
- A handler that returns a `Response` needs `output: raw()`, or the engine answers 500 (`ARKI_HTTP_E510`).
- A contract must agree with itself: params match the path (`ARKI_HTTP_E011`, thrown at declaration).
- `public-fetch` refuses private addresses, also after DNS and redirects. Do not work around it.
- Do not read the ambient context (`@arki/http/context`) when a deriver would do.
- Unexpected error messages are redacted when `NODE_ENV=production`.
- Boot-time codes (`E0NN`) surface in `app.diagnostics`. Wire codes (`E4xx`, `E5xx`) surface in the envelope.

## Errors

The full table is in `README.md` under "Error codes", and every code has `@fix` and `@verify` JSDoc in `src/error.ts` and `src/dot.ts`. The ones agents meet most:

| Code             | Meaning                                            | What to do                             |
| ---------------- | -------------------------------------------------- | -------------------------------------- |
| `ARKI_HTTP_E002` | Two bindings claim the same method and path.       | Remove one binding.                    |
| `ARKI_HTTP_E011` | The route contract disagrees with itself.          | Make params match the path.            |
| `ARKI_HTTP_E013` | A schema has no JSON Schema form.                  | Use `withJsonSchema`.                  |
| `ARKI_HTTP_E400` | Request validation failed.                         | Send a request that fits the contract. |
| `http.idempotency_key_reused` | An idempotency key was reused for another request. | Use a new key.                         |
| `ARKI_HTTP_E510` | A `Response` without `output: raw()`.              | Declare `raw()`.                       |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```

In an app that mounts the plugin: the static graph, then the booted app's health.

```sh
dot explain --json | jq '.data'
dot doctor --json | jq '.data'
```

`dot explain` reads the manifest and starts nothing. `dot doctor` boots the app and disposes it.

For shared action execution and the validation owner, see Dot’s
[action migration guide](../../dot/docs/upgrade-actions.md). Native adapters retain
their own authorization, response headers and declared failures.
