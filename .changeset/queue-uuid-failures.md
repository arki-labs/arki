---
'@arki/contracts': minor
'@arki/queue': minor
---

Add UUID generation to canonical ID declarations and use one nominal Queue job
identity across direct triggers, producer clients and local queues.

Job triggers return precise generation failures before contacting the transport.
Handle `JOB_TRIGGER_FAILURES` before using the successful ID. Generated keys keep
their UUID format; explicit keys and pg-boss's durable duplicate mapping retain
their stored values.
