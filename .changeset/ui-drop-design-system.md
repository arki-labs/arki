---
'@arki/ui': minor
---

Breaking: `@arki/ui/design-system` is removed, and `@arki/ui` no longer depends on `@arki/design-systems`. The components read the standard shadcn token names, so any shadcn-compatible theme works; the README shows a minimal setup. Migrate: import design-system ids and helpers from the package that defines your themes instead.

no demo impact: no demo imports `@arki/ui/design-system`.
