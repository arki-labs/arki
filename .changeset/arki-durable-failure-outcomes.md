---
"@arki/queue": minor
"@arki/schedule": minor
"@arki/journal": minor
"@arki/payments": patch
---

Preserve typed business failures across job execution, scheduled runs and durable
commands. BullMQ and pg-boss share outcome classification and explicit retry
decisions; persisted refusals cannot become successful jobs. Queue submission
returns canonical validation, unavailability or uncertain-acceptance failures.
Middleware failure types flow from their definitions.

Schedule clients infer success and refusal from each definition and distinguish
refused work from overlap, lock contention and unavailability. Journal rolls back
refused commands, supervises callback defects, returns receipt conflicts, and
persists typed diagnostics for incompatible pinned workflows.

Breaking migration: narrow enqueue results before using IDs or counting accepted
work; register the exported failure definitions at RPC boundaries; handle
`refused` schedule outcomes. Returned failures and unexpected defects are not
retried by default. Follow each package's upgrade guidance for persisted jobs
and workflow versions.

Payments preserves duplicate-pending-refund handling when Journal returns a
typed constraint rejection. Other transaction failures retain their identity,
including uncertain commits; the service does not retry or call the provider.
