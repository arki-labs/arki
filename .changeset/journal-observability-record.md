---
"@arki/journal": patch
---

The README now has an `## Observability` section: the `journal.command`, `journal.effect` and `journal.step` spans with their attributes, and what is left uninstrumented. A new test proves that inside a Dot app a command run by a usecase opens `journal.command` inside the usecase's span, through the command's transaction span.
