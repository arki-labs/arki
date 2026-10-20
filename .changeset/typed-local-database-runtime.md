---
'@arki/db': minor
---

Return canonical failures from local PGlite initialization and expose typed
owned cleanup. Generate a nominal UUID owner ID before filesystem mutation,
propagate exact failures through the Dot provider, and supervise Drizzle
construction and failed startup cleanup. Check `isFailure` before using the
result and use its `close()` method for typed cleanup. Raw PGlite retains its
foreign close contract.
