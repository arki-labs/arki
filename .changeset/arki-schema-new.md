---
'@arki/schema': patch
---

New package: Standard Schema helpers for every validator (Zod, Valibot, ArkType or a hand-written schema). Exports the spec types `StandardSchemaV1` and `StandardJSONSchemaV1` (with their namespaces), `SchemaInput`, `SchemaOutput` and `SchemaWithJson`; `parse` (sync, returns the schema output) and `parseAsync` (always rejects, never throws); `SchemaError` for bad data (with the schema's `issues`) and the coded `SchemaRunError` for a schema that cannot be run (`ARKI_SCHEMA_E001` async result in `parse`, `ARKI_SCHEMA_E002` validator threw, with the thrown value as `cause`, `ARKI_SCHEMA_E003` unsupported JSON Schema target), with `SCHEMA_ERROR_CODES`; `pathOf` and `formatIssues`, which read issue paths the same way for every validator; `isStandardSchema` (callable schemas included), `hasJsonSchema`, and `withJsonSchema`, which gives any schema a draft-2020-12 JSON Schema.
