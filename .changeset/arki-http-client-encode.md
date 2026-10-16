---
'@arki/http': minor
---

Output is now encoded, not parsed. The server runs each output schema (and each SSE event schema) in Zod's encode direction, so a codec works: a handler can return a `Date` and the wire carries the ISO string. Plain schemas behave as before. An output schema with a one-way `.transform()` now fails with a 500, because it has no encode direction; use `z.codec` instead. `SchemaLike` gains an `encode` method, which every zod schema already has.

New: `createClient` from `@arki/http/client` builds a typed fetch client from the same contracts. Params, query and body are typed and encoded the way the server decodes them, the output is decoded with the output schema, and failures throw `HttpError` with the server's error code. It uses only `fetch`, so it runs in browsers and React Native.
