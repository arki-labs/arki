---
"@arki/queue": patch
---

Trace flow enqueue validation, mapping and provider acceptance with a default producer span. Propagate its context to flow jobs while preserving explicit telemetry options and exact failure outcomes. Reentrant or broken reporting cannot repeat submission.
