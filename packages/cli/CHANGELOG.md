# @arki/cli

## 0.2.0

### Minor Changes

- 4b3dcb8: New command option `passthrough: true` for commands that hand stdout to a child process (`dot env run -- <cmd>`, like `op run`): `run` returns the child's exit code, and on success no envelope is written in any mode, so a pipe carries only the child's output. A failure returned before the child starts is written as usual.
- a905468: One way to write middleware (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, steps 1 and 2):

  - A step is a plain function: `(ctx) => object | Failure`. It reads the least context it needs, adds the keys of the object it returns, or refuses the call with a typed failure.
  - An around is a plain function: `<T>(ctx, next: () => Promise<T>) => Promise<T>`. It wraps everything declared after it and the handler, for a transaction, a retry or a span. It adds nothing to the context.
  - Order is declaration order. A step sees every key added before it.

  Each transport attaches the same functions:

  - `@arki/dot/orpc`: `impl.refund.use(step(authed)).use(around(inTransaction))`. A refusal is thrown as the typed error the procedure declares; a procedure that does not declare the step's failure does not compile.
  - `@arki/http`: `routes().use(step(authed)).use(around(inTransaction))`. A refusal answers with the same coded error envelope as a failure the handler returns; every route bound after the step must declare its failures. `step(fn, { failureHeaders })` adds response headers to a refusal (a `www-authenticate` challenge, say), typed by the step's own failures.
  - `@arki/queue`: `q.job.use(step(actorFromData)).use(around(inTransaction))`. A refusal is the job's outcome, as if the handler had returned it.
  - `@arki/schedule`: `defineSchedule({ …, with: [asSystem, inTransaction], handler })`. A refusal makes the run `refused`.
  - `@arki/cli`: `defineCommand({ …, with: [asOperator], run })`. `with` also wraps `preview`. A refusal is the command's failure: same exit code and error output as a failure returned from `run`.

  In `with: [...]` lists, an around is told from a step by `fn.length >= 2`: declare `next` as a plain second parameter (no default value, no rest parameter).

  Outside oRPC, a refusal reaches an around as the value `next()` resolves to, not as a throw: the `Failure` itself on queue, schedule and CLI, the refusal's `Response` on HTTP. An around that must roll back on a refusal checks `isFailure` on the result (on HTTP, the response status). A thrown error still rejects `next()`.

  `@arki/failure/orpc` adds `rpcError(failure, errors)`: the declared `ORPCError` for a failure already in hand, to throw.

### Patch Changes

- 5d55e12: Docs only: the agent guide names the Dot middleware doc in plain text instead of a link that leaves the package. No code change.
- 8c331b7: Hand-written object guards now come from `@arki/schema` (`is(value, recordSchema)` or `plainObjectSchema`), per A-39. Replaced: the `isRecord`/`isPlainObject`/`isObject` helpers in `dot`, `cli`, `http`, `expr`, `lock`, `mail`, `embeddings` (its internal `isRecord`, not a public export), `testing` and `payments`, plus inline `typeof x === 'object' && x !== null` checks on unknown values. Behaviour is the same, except that the inline checks and `lock`'s guard no longer let arrays through. `@arki/expr` and `@arki/lock` now depend on `@arki/schema`.
- ef7fe42: `dot env`: encrypted env files from the command line. `init` (header, private key, `.gitignore`, agent read-deny), `set` (encrypts with the public key only, so agents can write without reading; refuses a no-op), `get` (shape only; `--reveal` on a terminal), `ls`, `check` (CI gate: unloadable files, refused keys, plaintext `secret()` keys in tracked files, tracked `.env.keys`), `encrypt` (`--from` imports a plaintext file), `decrypt`, `rotate` (every `.env.<env>` file together), `run -- <cmd>` (passthrough; redacts secrets when stdout is not a terminal), `explain`, and `keys push|pull` (1Password, key via stdin). Failures `dot.env_*`. Commands read `secret()` keys from the app's `src/env.ts` with validation skipped; where it cannot be imported (Node) they report `dot.env.schema_unavailable`, which fails `check` when a tracked file holds a plain value. `dot dev` now opens encrypted values in env files before its database check.

  `@arki/cli`: a positional array argument is no longer split on commas (`node -e "f(a, b)"` stayed two pieces).

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
