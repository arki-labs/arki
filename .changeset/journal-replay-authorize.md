---
'@arki/journal': patch
---

Fix: a call that replays an idempotency receipt no longer skips authorization. `j.command` takes an optional fourth argument, `{ authorize }`, which runs inside the command's transaction on every call, a replay included, before the stored result is returned. Move permission checks out of handlers and into `authorize`: a replay never runs the handler.
