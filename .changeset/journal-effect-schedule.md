---
'@arki/journal': minor
---

Effects can carry a schedule: `j.effect(...).withSchedule({ priority, delaySeconds, runAt })`. Higher priority is claimed first among due jobs; `delaySeconds` and `runAt` hold a job until it is due. Schema change, additive: `priority integer not null default 0` on `journal_jobs`, and the due index becomes `(priority desc, available_at) where dead_at is null`. The oRPC 409 message now asks the client to reload first.
