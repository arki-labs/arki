---
'@arki/queue': minor
---

Correct the queue worker's missing-client diagnostic to `ARKI_QUEUE_E019` and its documentation link. `ARKI_QUEUE_E006` keeps its original meaning: a missing job, schedule or flow name. Code matching for a missing queue client must use `QUEUE_PLUGIN_ERROR_CODES.clientMissing` or the new literal. Add fixes and verification commands to the queue error index.
