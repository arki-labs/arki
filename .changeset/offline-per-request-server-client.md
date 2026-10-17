---
'@arki/offline': minor
---

`createOfflineRuntime` no longer shares one QueryClient across server requests. On the server (SSR), `offline.Provider` now makes a fresh, unpersisted QueryClient for each request (`gcTime: Infinity`, TanStack Query's server default), so one user's cached data never reaches another user's server-rendered page. In the browser nothing changes: one persisted client for the app's lifetime.

Breaking: `offline.queryClient` and `offline.persistNow()` are browser only. On the server, reading `offline.queryClient` throws and `persistNow()` rejects. Read the client with `useQueryClient()` inside `offline.Provider`.
