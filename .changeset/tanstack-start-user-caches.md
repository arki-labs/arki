---
'@arki/tanstack-start': patch
---

`@arki/tanstack-start/pwa/client` adds `clearCachesOnUserChange(userId)` and `useClearCachesOnUserChange(userId)`. They delete the service worker's user-tied caches (every cache but the Workbox precache of built files) when the signed-in user differs from the one the caches were filled for: a sign-out, a deleted account, or a new session that replaced another user's. Who filled the caches is one Cache Storage entry holding only the user id. `clearCachesOnUserChange` resolves `true` when the caches belonged to another known user, so the app can drop that user's other offline data (such as a persisted query cache) on the same decision; pass `undefined` to the hook while the session is loading or failed to load, so an offline reload never reads as a sign-out.
