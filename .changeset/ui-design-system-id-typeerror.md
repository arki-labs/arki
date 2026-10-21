---
'@arki/ui': minor
---

`parseDesignSystemId` (re-exported from `@arki/design-systems/registry`) now throws a `TypeError` for an unknown id instead of a `ZodError`. `designSystemIdSchema` is still exported; it now comes from `@arki/design-systems/registry/schema`. Migrate: catch `TypeError`, or validate with `designSystemIdSchema.safeParse` when you need Zod's issue list.

no demo impact: no demo calls parseDesignSystemId or catches its error.
