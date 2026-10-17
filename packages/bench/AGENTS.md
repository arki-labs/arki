AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/bench: Laws

A dev-time tool for benchmarks you can publish. Read these before you change or use it.

## Laws

1. Never game a benchmark. Every case must do the same work, and the contract proves it before anything is timed. A failed group is not timed.
2. Never write benchmark numbers by hand. README tables come from a saved `publish` result through `--write-readme`, and only from an idle machine.
3. Only a `publish` run can be publishable. A rough result is shown as rough, with its reason, and never edited to look clean.
4. Every number carries a 95% interval, and the run records versions, machine, flags, git revision and load.
5. One timed function per case. No case benefits from running first at a shared call site.
6. Change the contract id (`sum/v1` to `sum/v2`) whenever the work changes. Runs with different contract ids are never compared.
7. `@arki/bench` stays a dev-time tool. It supports Node and Bun. Do not import it into code that serves requests.
8. The result schema is the public contract. Changing a field changes the schema version and the docs in the same commit.
9. Data goes to stdout, progress to stderr. Exit codes: 0 ok, 1 a check failed, 2 bad command line.
10. Types are written once and inferred everywhere. No `any`, no `@ts-ignore`, no unsafe casts.

## Changing this package

- A new warning code goes into `warnings.ts`. If it blocks publishing, add it to `BLOCKING_WARNINGS` and document it.
- The version constant in `src/core/version.ts` must equal `package.json`. A test checks this.
- `examples/sum.bench.ts` is the quick start in `README.md`. `src/examples.test.ts` keeps it a valid suite.
- Doc examples live in `README.md` and `docs/`. Run them with `bun run test:docs`.
- Never run a `publish` profile benchmark to refresh a README while other work is running.

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
