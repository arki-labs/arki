---
'@arki/offline': patch
---

`createOfflineRuntime` and `createPersistedQueryClient` now return `persistNow()`. It writes the persisted query cache to IndexedDB at once and resolves when it is stored. The automatic writes are throttled to one a second and never say when they finish, so a page that reloaded right after a delete could restore the item from the older snapshot. Await `persistNow()` after removing a query that must not come back. `createIdbPersister` returns an `IdbPersister` (a `Persister` plus `persistClientNow`). `createOfflineRuntime` now passes the resolved build buster to the provider too, so the stored cache and the restore check use the same string.
