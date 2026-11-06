---
"@arki/schedule": patch
---

The README now has an `## Observability` section: the `schedule.run` span with its attributes and outcomes, the `schedule.run.duration` histogram, and what is left to `@arki/lock`. A new test proves that inside a Dot app the usecase a schedule handler calls nests under `schedule.run`.
