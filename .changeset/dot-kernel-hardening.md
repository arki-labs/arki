---
"@arki/dot": patch
"@arki/event-sourcing": patch
---

Kernel hardening from external (Codex) review of the v2 DI system:

- **Lifecycle transitions serialized** — `boot`/`start`/`stop`/`dispose` run on a single transition queue; same-transition calls coalesce (start hooks can no longer double-run), different transitions re-check state at the head of the queue. Fixes a race where `dispose()` completing during a slow `start()` was overwritten by the resuming start, resurrecting a disposed app.
- **Lazy auto-dispose ownership** — a republished `Lazy<T>` handle is cleaned up only by its first publisher, after that pip's own dispose hook, instead of being closed early by the republisher's record under reverse-order teardown.
- **Reserved `$` keys enforced** (`DOT_LIFECYCLE_E014`) — `pip()` rejects `$`-prefixed needs aliases and publish keys at compile time; the kernel validates aliases, publish keys, and `rename()` targets at runtime so `$app`/`$pip`/`$config` can never be shadowed.
- event-sourcing: corrected a stale "reverse-topological order" doc comment (v2 disposes in reverse declaration order).
