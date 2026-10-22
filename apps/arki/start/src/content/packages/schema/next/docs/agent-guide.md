# @arki/schema for agents

## Parse a value

Import spec types and execution helpers from `@arki/schema`. Bring a Standard Schema validator. `parse(schema, unknown)` returns its output or a canonical failure; narrow with `isFailure` from `@arki/failure` before using the output. Transformed output keeps the schema's exact type.

## Parse with an async schema

Await `parseAsync(schema, value)`. It resolves to output, `InvalidInput` or `ValidatorDefect`. Sync `parse` also returns `AsyncSchema` for async validation and observes discarded promise rejections.

## Report bad data

Check `InvalidInput.is(result)`, then read `result.data.issues`. `pathOf(issue)` returns plain path keys and `formatIssues(issues)` formats all messages. Validator defects and async mismatch are never invalid user data or HTTP 400.

A foreign API requiring exceptions can use `orThrow(result)` from `@arki/failure`; it throws `UnexpectedFailure` with the exact original failure. Do not introduce a throwing parse alias.

## Accept any schema at runtime

Use `isStandardSchema(value)` to recognize callable and object schemas. Source types are `StandardSchemaV1` and `StandardJSONSchemaV1`. The failure foundation imports the external spec directly to keep dependencies acyclic.

## Give a schema a JSON Schema

Use `hasJsonSchema(schema)` before reading converters. `withJsonSchema(schema, input, output?)` supplies draft-2020-12 converters. Unsupported targets throw `SchemaRunError` (`ARKI_SCHEMA_E003`); validation uses returned failures.

## Throw on a bug

`parse` for data that may be bad (returns). `assert(value, schema, { at })` for a value that must be right (throws, narrows to the input type, never transforms). `ensure(value, schema)` returns the output (throwing `parse`). A failure is `AssertError` with `ARKI_SCHEMA_E004`; an async schema is `ARKI_SCHEMA_E005`. The message never contains the value. `is(value, schema)` is the boolean guard. For an object check use `is(value, recordSchema)` or `plainObjectSchema`, not a hand-written guard.

## Verify

Run `bun run build`, `bun run typecheck`, `bun run test`, `bun run lint`, `bun run test:docs`, then `bun run test:runtimes --require-all`. Runtime provisioning failures must remain explicit. Run `bun ../../tooling/library/src/llms.ts --check` for the export map.
