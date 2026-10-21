---
'@arki/http': minor
---

`buildEngine` now routes with its own compiled router and keeps Hono behind it. Each route whose path is static segments and `:name` segments is matched by a `Map` or a segment trie built once; mounts, rpc mounts, routes under a mount prefix, optional placeholders (`:x?`), wildcards and the 404 still go to Hono. Every route runs the same pipeline as before, so responses and error envelopes are unchanged. Measured on the package's new server benchmark (`bun run bench:server`): about 10 % less server CPU per request on Bun and Node, and up to 40 % more throughput on parameter routes on Bun.

New: `buildHonoEngine` builds the Hono-only engine, for running both side by side. `Engine.bunRoutes` carries the routes Bun can match natively; `listen(engine, options)` accepts an engine and passes them to `Bun.serve({ routes })` (`listen(fetch, options)` still works). `composeMiddleware(engine, middleware)` wraps an engine, including its Bun route handlers, and returns an engine; the `http()` Dot plugin uses it so the in-flight gauge and app middleware see every request. Zod schemas in contracts are compiled once with `z.compile()` when first used; the request context parses `url` on first read; a route that declares no params, headers, query or body skips input decoding; the request span costs nothing when no tracer records it.
