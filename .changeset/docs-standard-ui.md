---
'@arki/ui': patch
---

Docs standard: README sections, AGENTS.md, llms.txt, agent guide and checked doc examples.

Removes two `exports` entries that pointed at files that do not exist: `.` (`src/index.ts`) and `./toast` (`src/toast/index.ts`). Importing either already failed, so no working import changes. Use the per-component subpaths, for example `@arki/ui/button` and `@arki/ui/sonner`.
