---
'@arki/live': minor
---

New package: live queries on your own Postgres, milestone M0 (correctness and type proof). `@arki/live` has the wire schemas (`tableTagSchema`, `liveMetaSchema`, `liveManifestSchema`, `liveCursorSchema`, `liveEventSchema`), `live()` meta from tags, `affectedPaths`, `LIVE_ERROR_CODES`, and the portable hub `createLiveHub`: hints are batched into numbered frames per random epoch, a bounded replay ring lets a reconnect resume, and everything else (no cursor, another epoch, an evicted cursor, a listener gap) resets. `@arki/live/drizzle` adds `live()` from Drizzle tables, `tableTag` and `snapshot()` (one `REPEATABLE READ READ ONLY` transaction per call; a `tx` handle is refused). `@arki/live/orpc` adds `liveRead()`, the middleware that runs a live procedure inside one snapshot and puts the readers on `context.liveRead`. `@arki/live/testing` adds `fakeSource()`.
