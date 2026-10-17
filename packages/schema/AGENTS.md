AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/schema

## Laws

1. This package runs schemas. It never defines or replaces a validator.
2. `parse` and `parseAsync` return the schema's output type, never its input type.
3. Two errors, never mixed. `SchemaError` is bad data. `SchemaRunError` is a broken or misused schema and carries a code.
4. Never map a `SchemaRunError` to an HTTP 400. The validator has a bug.
5. Import the spec types (`StandardSchemaV1`, `StandardJSONSchemaV1`) from `@arki/schema`, never from `@standard-schema/spec`.
6. Nothing here may import a validator. Zod, Valibot and ArkType appear only in tests, examples and docs.
7. No Node or Bun built-ins in `src/`. The package must run in browsers and Hermes.
8. `parseAsync` rejects. It never throws before it returns a promise.
9. `withJsonSchema` answers `draft-2020-12` only. Any other target throws `ARKI_SCHEMA_E003`.
10. Every error code has a JSDoc summary, `@fix` and `@verify`.

## Changing this package

1. Read `src/types.ts` and `src/parse.ts` first.
2. A change that touches a vendor needs a case in `src/vendors.test.ts` for Zod, Valibot and ArkType.
3. A changed doc example goes in `examples/signup.ts`. Run `arki-doc-examples --write` to refresh the README.
4. Add a changeset. Behaviour changes are `minor` while the version is below 1.0.

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs
bun run build && bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
