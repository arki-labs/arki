---
'@arki/queue': minor
---

Two browser-safe subpaths, so an oRPC contract that ships to the browser no longer bundles bullmq:

- `@arki/queue/errors`: `JOB_TRIGGER_FAILURES`, `QueueUnavailable`, `QueueAcceptanceUnknown` and the declaration error codes. The trigger failures moved here from the trigger module. The root still exports them.
- `@arki/queue/contract`: everything a contract needs: `JOB_TRIGGER_FAILURES`, the two trigger failures, `queueJobId`, and the types `JobTriggerFailure`, `JobTriggerResult`, `QueueJobId`.
