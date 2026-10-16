---
'@arki/failure': minor
---

Breaking: failure data is typed as the schema's **output**, and the package builds on `@arki/schema`.

- `StandardSchemaV1` and `SchemaInput` are no longer exported. Import them from `@arki/schema`.
- `DataOf<Schema>` is the schema's output type, the live value a failure carries. It was the input type, which disagreed with `revive`, which passes the validated output to the definition.
- `StandardSchemaV1` is now the real spec type, stricter than the old local copy (`validate` must return a Standard Schema result).
- New dependency: `@arki/schema`.
- `FailureError` takes an optional fourth argument, `ErrorOptions`.
- `revive` validates with `@arki/schema`'s `parse`. `ARKI_FAILURE_E006` and `ARKI_FAILURE_E007` now carry the `SchemaError` / `SchemaRunError` as `cause`. A validator that throws is no longer reported as bad data: its `SchemaRunError` (`ARKI_SCHEMA_E002`) passes through.
