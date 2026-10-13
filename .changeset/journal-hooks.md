---
'@arki/journal': minor
---

Around-hooks: `journal.hooks.command.around(fn)` and `journal.hooks.effect.around(fn)` are the one way to watch or stop a run from outside. `fn(ctx, next)` runs inside the transaction (commands) or the lease (effects), in registration order with the first outermost. Enforced: `next` exactly once or throw before it; a rejection of `next` is the hook's rejection; the context is frozen and the result cannot be changed; registration is frozen once the journal has run a command, a drain or a worker.
