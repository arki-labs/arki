---
'@arki/journal': minor
---

`initJournal({ meta })`, `JournalDefinitions`, `Journal`, `CommandRunner` and the `@arki/journal/dot` types take a meta schema of any Standard Schema with a plain-record output (`StandardSchemaV1<unknown, Record<string, unknown>>`), not only `z.ZodObject`; `meta` types are `SchemaInput`/`SchemaOutput` of it.
`j.event(type, schema, { upcasters })` and `j.command(name, input, handler)` take any Standard Schema (Zod, Valibot, ArkType, hand-written); event constructor, write, replay and upcasters parse sync, command input and meta parse async.
Data or `meta` that fails its schema now throws `SchemaError` from `@arki/schema` (with `issues`), not `ZodError`; a schema that cannot run (async where parsing is sync, or a throwing `validate`) throws `SchemaRunError` and is never reported as `REPLAY_FAILED`.
`initJournal()` without `meta` uses a built-in schema that accepts a plain object and records `{}`; the package no longer imports zod.
