---
'@arki/admin': minor
---

`defineRead`, `defineAction`, `defineSignal` (and the `Read`, `Action`, `Signal`, `AnyRead`, `AnyAction` types) take any Standard Schema (Zod, Valibot, ArkType, hand-written) instead of `z.ZodType`; the preview schema bound is `StandardSchemaV1<unknown, Revisioned>`. Handler types use `SchemaInput`/`SchemaOutput`.
Input and output are validated with `parseAsync`; bad data is still `ARKI_ADMIN_E004`/`E005`, now with `SchemaError` as the cause. A validator that throws propagates as `SchemaRunError`.
The manifest JSON Schema comes from the schema's own converter (`input` for inputs, `output` for results and payloads). A schema without one, or whose conversion throws, fails at define time naming the read/action id and `withJsonSchema`.
`journalReceiptStore` takes a `Meta` of any Standard Schema with a record output.
