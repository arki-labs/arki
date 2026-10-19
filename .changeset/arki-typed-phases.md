---
'@arki/dot': minor
'@arki/db': minor
'@arki/journal': minor
'@arki/mail': minor
'@arki/queue': minor
'@arki/resilience': minor
'@arki/schedule': minor
---

Carry inferred failures through configure, boot, start, stop and dispose, with atomic service publication, rollback aggregation and supervised usecase invocation even without tracing. Configure now returns a typed outcome and remains synchronous with no I/O; logging activates during boot. Detached lifecycle callbacks must prove an undefined or concrete failure return rather than void.

Breaking: check configure before accessing the manifest, inspect stop/dispose outcomes, and handle managed CLI preflight failures under `dot.preflight_failed` in `.error.data.{app,migrations,report,failure}` (exit 3). Successful JSON paths remain unchanged. See `docs/upgrade-phases.md` for phase-specific outcomes and migration steps.

Cron oRPC adapters route canonical supervised defects through the existing failure policy before success mapping; business refusals keep their explicit responders.

Database, mail, queue, resilience and Journal adapters retain their authored factory and lifecycle return types, including driver-specific service types.
