AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/schema

## Laws

1. This package runs schemas. It never defines or replaces a validator.
2. `parse` and `parseAsync` return the schema output or exact canonical failures from `@arki/failure`.
3. `InvalidInput` means bad data. `AsyncSchema` and `ValidatorDefect` mean schema misuse or defects; never map them to HTTP 400.
4. `SchemaRunError` only covers unsupported JSON Schema conversion targets. `AssertError` covers the throwing channel.
5. Consumers import spec types from `@arki/schema`; the failure foundation imports the external spec directly.
6. Nothing here may import a validator. Zod, Valibot and ArkType appear only in tests, examples and docs.
7. No Node or Bun built-ins in `src/`. The package must run in browsers and Hermes.
8. `parseAsync` resolves to output or a canonical failure, including thrown/rejected validator defects.
9. `withJsonSchema` answers `draft-2020-12` only. Any other target throws `ARKI_SCHEMA_E003`.
10. Every error code has a JSDoc summary, `@fix` and `@verify`.
11. Two channels, same issues: `parse` = expected failure, returns. `assert`/`ensure` = bug, throws `AssertError`. `assert` never transforms; `ensure` returns the output.
12. `AssertError` never contains the raw value (secrets). Issue messages are redacted, paths are plain keys.
13. `is`, `assert`, `ensure` are sync. An async schema throws `ARKI_SCHEMA_E005`; never hang or return a Promise.
14. Every check of an unknown value is a schema: `recordSchema` and `plainObjectSchema` replace guard functions. Only `isStandardSchema` and `hasJsonSchema` stay as plain guards (the schema layer's own internals).
15. `assert` is a `function` declaration, exported by name, so `asserts` narrowing works (no TS2775).

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
