---
'@arki/auth': patch
---

`ArkiAuthProvider` takes an optional `onUserChange(userId: string | null)` prop. It is called with the signed-in user's id, or `null` when signed out, each time that changes (sign-in, sign-out, or a new session that replaced another user's). It is never called while the session is loading or failed to load, and not twice in a row for the same user. Use it for per-user cleanup, such as dropping the previous user's offline caches.
