# @arki/schema for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. This package runs Standard Schema validators. It does not define one.
2. `parse` and `parseAsync` return the output or a canonical failure. Expected bad data is a returned `InvalidInput`.
3. `assert`, `ensure` and `is` are the throwing channel, for bugs only.
4. `withJsonSchema` adds draft-2020-12 converters to a schema. Any other target throws.
5. The dependency graph is schema, then failure, then the Standard Schema spec types.

## Task map

### Parse a value

Import spec types and execution helpers from `@arki/schema`. Bring a Standard Schema validator. `parse(schema, unknown)` returns its output or a canonical failure; narrow with `isFailure` from `@arki/failure` before using the output. Transformed output keeps the schema's exact type.

### Parse with an async schema

Await `parseAsync(schema, value)`. It resolves to output, `InvalidInput` or `ValidatorDefect`. Sync `parse` also returns `AsyncSchema` for async validation and observes discarded promise rejections.

### Report bad data

Check `InvalidInput.is(result)`, then read `result.data.issues`. `pathOf(issue)` returns plain path keys and `formatIssues(issues)` formats all messages. Validator defects and async mismatch are never invalid user data or HTTP 400.

A foreign API requiring exceptions can use `orThrow(result)` from `@arki/failure`; it throws `UnexpectedFailure` with the exact original failure. Do not introduce a throwing parse alias.

### Accept any schema at runtime

Use `isStandardSchema(value)` to recognize callable and object schemas. Capability predicates return `false` for inaccessible or malformed protocols, including revoked proxies and throwing accessors. Native promises with usable constructor/species hooks are observed once without awaiting them; probes do not invoke arbitrary `then` accessors. Observation is reserved before those hooks run, so reentry cannot repeat it. A provider that blocks handler registration retains responsibility for its own rejection. Source types are `StandardSchemaV1` and `StandardJSONSchemaV1`. The failure foundation imports the external spec directly to keep dependencies acyclic.

### Give a schema a JSON Schema

Use `hasJsonSchema(schema)` before reading converters. `withJsonSchema(schema, input, output?)` supplies draft-2020-12 converters. Unsupported targets throw `SchemaRunError` (`ARKI_SCHEMA_E003`); validation uses returned failures.

### Throw on a bug

`parse` for data that may be bad (returns). `assert(value, schema, { at })` for a value that must be right (throws, narrows to the input type, never transforms). `ensure(value, schema)` returns the output (throwing `parse`). A failure is `AssertError` with `ARKI_SCHEMA_E004`; an async schema is `ARKI_SCHEMA_E005`. The message never contains the value. `is(value, schema)` is the boolean guard. For an object check use `is(value, recordSchema)` or `plainObjectSchema`, not a hand-written guard.

## Rules that bite

- Never map `schema.validator_defect` or `schema.async_required` to HTTP 400. Only `schema.invalid_input` is bad user data.
- Sync `parse` cannot await async checks. Use `parseAsync`.
- `assert` never transforms. `ensure` returns the output.
- Do not add a throwing parse alias. A foreign API that needs exceptions uses `orThrow(result)` from `@arki/failure`.
- For an object check use `is(value, recordSchema)` or `plainObjectSchema`, not a hand-written guard.
- `pathOf` returns keys, so a field name containing a dot stays one segment.

## Errors

| Code               | Meaning                                                                       | What to do                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ARKI_SCHEMA_E003` | A `withJsonSchema` converter was asked for a target other than draft-2020-12. | Ask for the `draft-2020-12` target.                                                                            |
| `ARKI_SCHEMA_E004` | `assert` or `ensure` got a value the schema rejects.                          | Read `issues` on the error, then fix the code that produced the value. Use `parse` where bad data is expected. |
| `ARKI_SCHEMA_E005` | `is`, `assert` or `ensure` got a schema that validates asynchronously.        | Use `parseAsync`, or a schema that validates synchronously.                                                    |

Returned failures: `schema.invalid_input`, `schema.async_required`, `schema.validator_defect`. Check them with `InvalidInput.is(result)` and the other definitions from `@arki/failure`.

## Verify

Run `bun run build`, `bun run typecheck`, `bun run test`, `bun run lint`, `bun run test:docs`, then `bun run test:runtimes --require-all`. Runtime provisioning failures must remain explicit. Run `bun ../../tooling/library/src/llms.ts --check` for the export map.
