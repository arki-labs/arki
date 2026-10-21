# @arki/cli

## 0.1.0

### Minor Changes

- 2faafcb: New package: typed command-line programs from one `defineCommand({...})`. The input schema (any Standard Schema with JSON Schema) drives the flags, their coercion and their help; `run` returns data or an `@arki/failure` value, and the output type is inferred with failures removed. `defineCli` builds a lazy command tree with groups, aliases and "did you mean" suggestions; `main(argv, io)` returns the exit code without touching the process, and `run(program)` is the process boundary (argv, stdio, terminal, SIGINT/SIGTERM). A run writes the `arki.cli/1` JSON envelope when stdout is not a terminal and text when it is (`-o`, `--json`, `ARKI_OUTPUT` override; `--fields`, ndjson), with stable exit codes (0 ok, 1 bug, 2 usage, 3 failure, 4 retryable, 5 input required, 130 interrupted). Global flags: `--input-json`, `--input-file`, `--dry-run` (runs `preview`), `-q`, `-h`, `--version`. Help and `--version` never run a command or resolve services. Runs on Node, Bun and Deno.
- 232d3e8: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

### Patch Changes

- dcf2cef: Docs standard: the README now has install, quick start, when not to use it, runtime support, public imports, failure behaviour (with every `cli.*` code), limits, documentation and support. New `AGENTS.md` and `CHANGELOG.md`; every framework failure carries `@fix` and `@verify` in its JSDoc.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

## 0.0.0

- First version: typed commands from one `defineCommand`, a JSON envelope when piped, text on a terminal, stable exit codes.
