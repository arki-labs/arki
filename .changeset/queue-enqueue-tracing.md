---
'@arki/queue': patch
---

Trace single-job enqueue attempts by default, including validation, identity
generation, transport refusals and uncertain acknowledgements. Producer spans
propagate through the existing BullMQ and pg-boss carriers. Instrumentation
failures cannot replace returned outcomes or repeat an enqueue.

Configure OpenTelemetry in the application. Explicit BullMQ telemetry options
retain their existing precedence. Flow enqueue and worker execution keep their
current instrumentation.
