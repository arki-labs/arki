---
'@arki/dot': minor
---

Adds `@arki/dot/orpc` and lets adapters read `defineFeature` features directly (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1b).

- `@arki/dot/orpc` (optional peer `@orpc/server`): `needsMiddleware<RequestContext>()` makes the app's `bind`; `bind(core)` puts a feature's needs, private infra and `usecases` on the handler context from `context.services` (an alias that shadows a request-context key does not compile). `rpc(contract, router)` is the oRPC entrypoint descriptor; the router must implement the contract (`Router<C, never>`), so a bare router, a missing procedure or another contract's router do not compile.
- Breaking for adapter authors: `driver(...)` / `driven(...)` now receive `MountedFeature[]` — object-form and chain features as mounted, no longer an object-form view of chain features. Read declarations with the new `entrypointsOf(f)` (chain `entrypoints` or object-form `use`), slice records with `sliceOf(ctx, f)` as before, and a chain feature's units with `f.plugins()`.
