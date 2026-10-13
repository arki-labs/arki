---
'@arki/env': patch
---

Reading a value from a `defineEnv()` env is faster once the env is in regular use. After 64 reads, an env whose values are private to it (validated on the server, or skipped with the runtime env `defineEnv` built itself) copies its values into the lazy object and reads them directly, instead of going through two proxies on every read. Writes and deletes through the env update the copy too. An env over your own `runtimeEnv` with validation skipped still reads it live.
