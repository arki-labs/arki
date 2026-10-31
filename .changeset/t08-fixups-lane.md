---
'@arki/tanstack-start': minor
'@arki/dot': minor
---

`@arki/tanstack-start`: the cron 401, request crashes, identity-lookup throws and the boot 503 now answer with a typed failure in the `{ error: { code, message } }` envelope (`tanstack_start.unauthenticated`, `tanstack_start.internal`, `tanstack_start.unavailable`). A failure thrown by `rpc`, `session` or `createContext` answers with its own status. The cron 401 no longer says which check failed.

`@arki/dot`: `toJsonObject` checks the value with a schema instead of hand-written guards. Same inputs are accepted and refused, same `ARKI_DOT_E032` error.
