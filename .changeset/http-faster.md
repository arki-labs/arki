---
'@arki/http': patch
---

Faster request handling for bound routes. Responses and error envelopes are unchanged.

- A route with no derivers and no body now runs its handler without extra promises: a handler that returns a value is answered synchronously, and only a returned promise is awaited.
- JSON output is written as a string body with `content-type: application/json`, the same response `Response.json` builds, at a lower cost per request.
