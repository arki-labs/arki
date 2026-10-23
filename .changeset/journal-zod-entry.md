---
'@arki/journal': minor
---

Public types no longer name Zod (`TYPES_E001`). Breaking:

- The schemas that decode stored values move to the new `@arki/journal/zod` entry and take `xSchema` names: `storedEventRowSchema` and `forwardArgsSchema` (were `StoredEventRow` and `ForwardArgs` in `@arki/journal/pg`), and `eventLogPositionSchema` (was the `EventLogPosition` value in `@arki/journal`). The types keep their names and places.
- `EventLogPosition` is a TypeScript brand (`string & { readonly [brand]: true }`) made only by `eventLogPositionSchema`, which `z.custom` builds on a `z.string().min(1)` check.

See `docs/upgrades/0.3.0-to-0.4.0.md`, step 10.
