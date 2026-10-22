---
'@arki/dot': minor
---

`provides` factories now get only `{ usecases }`, and entrypoints get only usecases, request keys and needs marked `entrypointOnly(...)`. They can no longer read repos, infra or plain needs. To publish data that sits behind a repository, write a one-line usecase and provide it; a consumer in another feature then gets `Value | Failure<'failure.unexpected_defect'>`. `CoreServices` is gone; use `ProvidesDeps` and `EntrypointServices`.
