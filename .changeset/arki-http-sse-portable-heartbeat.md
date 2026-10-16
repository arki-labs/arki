---
'@arki/http': patch
---

SSE heartbeats work outside Node and Bun. `sseResponse` called `.unref()` on the heartbeat timer, which throws where `setInterval` returns a number (browsers, Deno's web API, Hermes), so any SSE route with `heartbeatMs` failed to open there. It now unrefs the timer only when the timer has an `unref` method.
