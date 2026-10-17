---
'@arki/queue': minor
---

A queue job takes a `retention` option: `.options({ retention: { completed, dead, retryableFor } })`. On the outbox lane the runner hands it to the journal as the override for that job name, so the job's finished and dead rows are kept as it says. The BullMQ lane ignores it.

`@arki/queue/foreman` raises its errors through `moduleError` from `@arki/admin/module`. A stale approval (`ARKI_QUEUE_E014`) and a job that is no longer failed (`ARKI_QUEUE_E015`) now answer 409, where they answered 500; an unknown queue (`ARKI_QUEUE_E016`) answers 404. `redactSecrets` is owned by `@arki/admin/module`; `@arki/queue/foreman` still re-exports it.

Breaking (0.x): `QueueForemanError` is removed. Match on the code of the `ModuleError` (`isModuleError` from `@arki/admin/module`) or on `QUEUE_FOREMAN_ERROR_CODES`.
