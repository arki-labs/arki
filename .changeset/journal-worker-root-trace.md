---
"@arki/journal": minor
---

Each job the worker runs now starts its own trace. Before, a worker started inside Dot's start hook put every `journal.effect` span (and the `journal.step` and command spans under it) under the `dot.unit.start` span, which had already ended, so background jobs looked like part of app startup. The worker's loops, its sweeper and its tap dispatch now run in the root context. Journal rows carry no OpenTelemetry context, so there is no producer trace to continue.

Docs: README `## Observability`.
