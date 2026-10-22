---
'@arki/live': minor
---

The documented `liveRead` one-liner now binds the readers through a usecase that takes the transaction (`snapshot(ctx.db, tx => ctx.usecases.readers(tx))`), because a request handler no longer reads infra.
