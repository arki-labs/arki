---
'@arki/schema': minor
---

Throwing channel next to `parse`: `is(value, schema)` (guard), `assert(value, schema, { at, message })` (narrows to the schema's input type; never transforms) and `ensure(value, schema, options)` (returns the schema's output, a throwing `parse`). A rejected value throws `AssertError` (`ARKI_SCHEMA_E004`) with the same `issues` that `parse` reports; the message lists them with paths and never contains the raw value. An async schema throws `ARKI_SCHEMA_E005` at once. Also adds the schemas `recordSchema` (non-null, non-array object) and `plainObjectSchema` (prototype is `Object.prototype` or `null`); use them as `is(value, recordSchema)`.
