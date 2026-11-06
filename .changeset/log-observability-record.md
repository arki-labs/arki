---
"@arki/log": patch
---

The README has an `## Observability` section: `@arki/log` makes no spans, and `@arki/log/otel` puts the active span's trace and span ids on each record. A new test proves it with a real tracer. No code change.
