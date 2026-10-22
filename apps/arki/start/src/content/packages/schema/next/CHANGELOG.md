# @arki/schema

## Unreleased

`parse` and `parseAsync` return canonical typed failures through the shared failure executor. `SchemaError` and validation-related `SchemaRunError` codes are removed; `ARKI_SCHEMA_E003` remains for unsupported JSON Schema targets.

## 0.2.0

### Minor Changes

- 6601242: Throwing channel next to `parse`: `is(value, schema)` (guard), `assert(value, schema, { at, message })` (narrows to the schema's input type; never transforms) and `ensure(value, schema, options)` (returns the schema's output, a throwing `parse`). A rejected value throws `AssertError` (`ARKI_SCHEMA_E004`) with the same `issues` that `parse` reports; the message lists them with paths and never contains the raw value. An async schema throws `ARKI_SCHEMA_E005` at once. Also adds the schemas `recordSchema` (non-null, non-array object) and `plainObjectSchema` (prototype is `Object.prototype` or `null`); use them as `is(value, recordSchema)`.

### Patch Changes

- 2000a7e: Fix: `is`, `assert` and `ensure` now answer about a value that is itself a failure. Before, `is(failureValue, recordSchema)` returned `false` for an invalid-input failure and threw for any other failure, because `parse` returns a failure-valued output and a rejection the same way. `@arki/failure/schema` now exports `executeSchema`, which runs a schema once without unwrapping (`{ value }` or a failure), and the throwing channel is built on it.
- Updated dependencies [6601242]
- Updated dependencies [2000a7e]
  - @arki/failure@0.2.0

## 0.1.0

### Minor Changes

- 232d3e8: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

### Patch Changes

- f6a15d0: New package: Standard Schema helpers for every validator (Zod, Valibot, ArkType or a hand-written schema). Exports the spec types `StandardSchemaV1` and `StandardJSONSchemaV1` (with their namespaces), `SchemaInput`, `SchemaOutput` and `SchemaWithJson`; `parse` (sync, returns the schema output) and `parseAsync` (always rejects, never throws); `SchemaError` for bad data (with the schema's `issues`) and the coded `SchemaRunError` for a schema that cannot be run (`ARKI_SCHEMA_E001` async result in `parse`, `ARKI_SCHEMA_E002` validator threw, with the thrown value as `cause`, `ARKI_SCHEMA_E003` unsupported JSON Schema target), with `SCHEMA_ERROR_CODES`; `pathOf` and `formatIssues`, which read issue paths the same way for every validator; `isStandardSchema` (callable schemas included), `hasJsonSchema`, and `withJsonSchema`, which gives any schema a draft-2020-12 JSON Schema.
- f43d509: Docs standard: AGENTS.md, CHANGELOG, a tested example, README sections in the standard order (`When not to use this`, `Limits`, `Failure behaviour`), and `@fix`/`@verify` notes on every error code.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- Updated dependencies [57313a4]
- Updated dependencies [f43d509]
- Updated dependencies [232d3e8]
- Updated dependencies [3f6d39f]
- Updated dependencies [7f9b4bb]
- Updated dependencies [86efafc]
- Updated dependencies [d541df1]
- Updated dependencies [f6a15d0]
- Updated dependencies [4913009]
- Updated dependencies [232d3e8]
- Updated dependencies [73ef41b]
- Updated dependencies [f796e5a]
  - @arki/failure@0.1.0

## 0.0.0

Not published yet. The first release adds the Standard Schema types, `parse`, `parseAsync`, issue helpers and the JSON Schema bridge.
