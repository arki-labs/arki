AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/cli — Laws

Rules for code in this package and for programs built on it. `@arki/dot`'s
`dot` command runs on this package, so a change here changes `dot` too.

## Laws

1. **Types are inferred, never written.** Input, output and services come
   from `defineCommand`. A consumer writes no type arguments.
2. **`main` never exits the process.** `main(argv, io)` returns the exit code
   and writes only to the `io` functions it was given. `run(program)` is the
   only process boundary.
3. **Failures are values.** `run` returns a failure from `@arki/failure`; it
   does not throw one. A throw is a bug: exit `1`, `cli.bug`.
4. **Exit codes are API.** `0` ok, `1` bug, `2` usage, `3` failure, `4`
   retry, `5` input required, `130` interrupted. They never change meaning.
5. **The envelope always has every key.** `arki.cli/1`: `ok`, `command`,
   `data`, `error`, `meta`. A missing key would break every `jq` filter.
6. **Help never runs a command.** `--help` and `--version` import at most one
   lazy level of the tree and never call `run`.
7. **Stdout belongs to the envelope.** Command output goes through the
   returned data or `ui.out`, never `console.log` or `process.stdout`.
8. **No logging setup.** The package never configures `@arki/log`; the bin
   file does.

## Changing this package

- A new framework failure gets a `defineFailure` with JSDoc (summary,
  `@fix`, `@verify`), an exit code in `FAILURE_EXIT_CODES`, and a row in the
  README `Failure behaviour` table.
- A change to the envelope or to exit codes is breaking for `dot` and every
  agent that parses it. Run `packages/dot`'s tests too.
- New global flags are reserved names: check that no consumer uses them as
  input keys.

## Consuming it

- Start with the README Quick start, then the
  [agent guide](docs/agent-guide.md) task map.
- Test a command with `program.main(argv, { stdout })` and assert on the
  parsed envelope and the exit code.

## Verify

Run in `packages/cli`:

```sh
bun run build
bun run test:docs
bun run typecheck
bun run test
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
bun ../../tooling/library/src/error-index.ts
```

The last line must report `0 without @fix/@verify`.
