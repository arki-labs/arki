---
"@arki/schedule": minor
---

A schedule tick now starts its own trace. Before, an `every` timer, a cron tick or a durable fire started `schedule.run` under whatever span was active when the app armed it. In a Dot app that was the `dot.unit.start` span, which had already ended, so every background run showed up as part of app startup. Now `schedule.run` for those ticks has no parent. `trigger(name)` still nests under the caller's span.

Docs: README `## Observability`.
