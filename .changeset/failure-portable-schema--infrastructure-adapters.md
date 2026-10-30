---
'@arki/schedule': patch
---

`defineFailure` no longer names the schema library in its type. A definition's `dataSchema` is typed `StandardSchemaV1<Input, Output>` (new `PortableSchema<Schema>`), so an exported failure stops printing `z.ZodObject<…>` into its package's `.d.ts` and consumers no longer depend on Zod's types. Breaking for code that called Zod methods on `definition.dataSchema` (`.safeParse`, `.shape`): keep the Zod schema in its own constant, or use `parse` / `is` from `@arki/schema`.

`@arki/schedule`: classifies lock provider codes with its own `lockCodeSchema` instead of Zod methods on `ScheduleLockFailed.dataSchema`.
