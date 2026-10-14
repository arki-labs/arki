---
'@arki/admin': minor
---

Core modules and two ways to attach Foreman. `@arki/admin/core` adds `withCoreModules`: `core.health` (status and checks in the v1 `fleetHealthSchema` shape) and `core.manifest` (the same manifest `GET /api/foreman/manifest` serves). `@arki/admin/env` adds `foremanEnvShape` and `foremanConfigFromEnv`: Foreman v2 is off with no `FOREMAN_*` variables set, and a partial set throws `ARKI_ADMIN_E014`. `@arki/admin/server` adds `createForemanHandlerFromEnv` for plain TanStack apps (a `routes/api/foreman/$.ts` catch-all). `@arki/admin/dot` adds `foreman()`, a `defineFeature` slice for DOT apps. Both attachments give identical manifests and read results.
