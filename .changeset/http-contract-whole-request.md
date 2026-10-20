---
'@arki/http': minor
---

A route contract now describes the whole request and response. `route.*()` takes `params` (a zod object with one key per path placeholder), `headers` (lower-case names; only the declared names are read) and `responses` (status to body schema). A handler answers a listed status with `reply(status, body, { headers? })`. An optional last path segment (`/orders/:id?`) serves both paths and appears twice in OpenAPI. `route.sse` takes `params` and `headers` too. The client sends typed params and headers, drops a missing optional segment, and decodes a body by `responses[status]` before `output`.

New exports: `raw`, `reply`, and the types `RawOutput`, `Reply`, `RouteDef`, `SseDef`, `ResponseSchemas`, `ParamSchema`, `HeaderSchema`.

Breaking changes:

- `RouteContract` and `SseContract` take `<TPath, TDef>` (the literal def) instead of positional `TQuery, TBody, TOutput, TFailures`. `RouteInput`, `RouteHandler`, `SseHandler` and `HandlerResult` follow. `ParamsOf` marks an optional placeholder's key optional.
- A contract with no `output` now answers 204 with an empty body, and its handler returns nothing. It used to return a `Response`. Manifests regenerate from code, so `action-meta` stays `@1`; its meaning changes from 200 to 204.
- Returning a `Response` needs `output: raw()`. Without it the engine answers 500 `ARKI_HTTP_E510`, and a plain value from a `raw()` route is `E510` too. The engine never validates a raw `Response`. `responses` may still document it (`x-arki-raw: true` in OpenAPI).
- A result that does not fit the contract (undeclared `reply` status, a value on a no-output route) answers 500 `ARKI_HTTP_E511`.
- An inconsistent contract throws `HttpConfigError` `ARKI_HTTP_E011` from `route.*()` (params not matching the path, bad optional placeholder, upper-case header, `responses` key outside 200-599 or 204/304, `responses[200]` next to a schema `output`).
- OpenAPI describes the wire form (`io: 'input'`), lists every declared status, and `createClient` resolves `undefined` for a no-output route and the `Response` for `raw()`.

`@arki/admin`: the four Foreman routes and the fleet snapshot route declare `output: raw()`. The fleet route documents its payload with `responses: { 200: fleetSnapshotSchema }`.
