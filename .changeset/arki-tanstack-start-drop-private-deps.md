---
'@fleet/tanstack-start': minor
---

Drops five dependencies the source never imported: `@arki/intl`, `@fleet/meter`, `@arki/ts`, `@tanstack/start-vite-plugin` and `nitropack`. The two private packages (`intl`, `meter`) no longer block publishing. Apps that relied on them being installed through this package must now depend on them directly. Nitro stays an app-level dependency (`nitro`), as in the app templates.
