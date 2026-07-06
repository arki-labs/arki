---
'@arki/dot': minor
---

Route manifest metadata + `dot explain --openapi`. `registerRoute` accepts
optional `description`, `input` (per-location JSON Schemas: `query`/`body`),
`output`, and `streaming` fields that flow into `manifest.routes` untouched
— adapters convert their validation schemas at `configure` time so the
manifest stays plain serializable data. `dot explain --openapi` renders an
OpenAPI 3.1 document straight from the static manifest (no boot): path
params, query parameters with required flags, JSON request/response bodies,
and `text/event-stream` responses for streaming routes. Mutually exclusive
with `--graph`; explain-only; composes with `--json`. Built for
`@arki/http`'s `registerRoutes`, usable by any adapter.
