AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/log

## Laws

1. Libraries log, apps configure. A library calls `getLogger('arki:<name>')` and never `configure()`. Only an app entry configures.
2. The core has zero dependencies and uses web-standard globals only. Node code lives in `src/node`, OpenTelemetry code in `src/otel`.
3. Importing does nothing: no env read, no output, no listener. Work happens when a function is called.
4. Values stay fields. Write `log.info('user {userId} signed in', { userId })`, never a template literal. Formatters render the template after redaction.
5. Logging never throws into the code that logs. A failing sink loses only its own copy. Only setup mistakes throw `LogError`.
6. A rule for a category replaces its parent's rule. It never adds, so no record is written twice.
7. Never log secrets. Add `redact([...])` to `processors` for every field that can hold one.
8. `fatal` writes. It never ends the process.
9. `@arki/log` knows a failure by its `'~failure'` brand. Do not import `@arki/failure` into `src/`.
10. Never write benchmark numbers by hand. The README bench block is generated.

## Changing this package

- Record shape and levels: `src/core/record.ts`, `src/core/levels.ts`. A change here touches every formatter and the OpenTelemetry sink.
- New sink or wrapper: `src/core/sinks.ts` or `src/core/wrappers.ts`. Export it from `src/core/index.ts`.
- New error code: add it to `LOG_ERROR_CODES` with JSDoc `@fix` and `@verify`.
- Run `bun ../../tooling/library/src/llms.ts --write` after an export change.
- Keep `README.md`, `llms.txt` and `docs/agent-guide.md` in step.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
