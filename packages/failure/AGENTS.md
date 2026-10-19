AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/failure

## Laws

1. A failure is returned, never thrown. A function returns `Value | Failure<...>`. Owned boundaries return typed defects; invalid static definitions still throw.
2. No wrapper. Success is the value itself. Never add an `ok(...)` or a `.value` step.
3. Write each type once. The failure union is inferred from the code. Do not write it by hand, and do not annotate a return type that inference already gives.
4. One `defineFailure` per kind of failure. Code, status, data schema and message live there. Boundaries, `match`, `recover` and `revive` read from it.
5. Codes are unique and dotted: `feature.reason`. `ok` is reserved.
6. Failure data is any Standard Schema. This foundation imports canonical types from `@standard-schema/spec`; it must never import `@arki/schema`.
7. Check before use: `isFailure(x)` or `Def.is(x)`. Never rely on truthiness or `??` to drop a failure.
8. A discarded failure is a lint error (`failure/must-use`). The only allowed discard is `// eslint-disable-next-line failure/must-use -- <reason>`.
9. Never call `accept(r)` after a bare `isFailure(r)`. Check the kind with `Def.is` first (`failure/no-blind-accept`).
10. `FailureError` marks misuse and is not handled. Fix the call. Match on `code`, never on the message.
11. Every error code in `src/errors.ts` has a JSDoc summary, `@fix` and `@verify`.
12. The core has no runtime dependencies. `@arki/failure/schema` owns minimal validation; `@arki/schema` depends on it. The `/orpc` entry imports `@orpc/client`, never `@orpc/server`, so browsers can load it.

13. Wire data is validated, lossless JSON whose schema accepts its output unchanged. Non-JSON or changing transforms need a separate wire definition.
14. Validation and revival return their precise canonical failures. No throw-only compatibility shim. Causes stay private.

## Changing this package

1. Read `src/failure.ts` first. The brand and the types live there.
2. A change to a type needs a type test or a test that would fail on the old behaviour.
3. A new error code goes in `FAILURE_ERROR_CODES` with a JSDoc summary, `@fix` and `@verify`, and a row in the README's Failure behaviour table.
4. A changed example goes in `examples/posts.ts`. Then run `bun run test:docs -- --write` through `arki-doc-examples --write` to refresh the README.
5. Add a changeset. Behaviour changes are `minor` while the version is below 1.0.

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
