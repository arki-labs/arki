---
'@arki/design-systems': minor
---

`@arki/design-systems/registry` is now plain data: importing it loads no Zod and validates nothing at import, so a page that only reads a system id no longer downloads Zod. The Zod schemas moved to a new subpath, `@arki/design-systems/registry/schema` (`designSystemIdSchema`, `designSystemMetadataSchema`). The types are unchanged and are now written in `registry`; an exact type test locks the schemas to them.

Breaking: import `designSystemIdSchema` and `designSystemMetadataSchema` from `@arki/design-systems/registry/schema` instead of `@arki/design-systems/registry`. `parseDesignSystemId` now throws a `TypeError` (was a `ZodError`). `DESIGN_SYSTEM_IDS` is now typed as the readonly tuple of ids.
