# @arki/http

## 0.0.1

### Patch Changes

- Initial public release of @arki/http — typed HTTP for ARKI.

  Route contracts as pure data (`route.get/.post/…/.sse`) with zod-validated
  query/body/output and typed path params; `routes()` bundles with
  request-scope deriver accumulation; SSE streaming (per-yield validation,
  coded error frames, signal-driven cleanup); fetch-shaped middleware;
  `toOpenApi` document generation; dual Bun/Node engine (Hono internal);
  and the DOT `http()` pip — bundle tokens as needs, ingress mounted last
  so it drains first on shutdown, coded `ARKI_HTTP_E*` diagnostics.

- Updated dependencies [4b1c59f]
  - @arki/dot@0.3.0
