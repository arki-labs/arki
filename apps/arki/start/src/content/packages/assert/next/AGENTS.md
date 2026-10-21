AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/assert

Two string checks, `isURL` and `isBase64`, one subpath each. Read [docs/agent-guide.md](./docs/agent-guide.md) for tasks. When a doc and the code disagree, the code in `src/` wins.

## Laws

1. One predicate per subpath. `@arki/assert/url` and `@arki/assert/base64` stay separate entries, and there is no root entry. A bundler then pulls in only the check you import.
2. A predicate returns `false` for a bad string. It never throws for a string. Only a value that is not a string may throw, and it throws the built-in `TypeError`.
3. A predicate is a pure function of its argument. No state, no I/O, no `node:*` import. That is what keeps it runnable on every engine.
4. `isURL` accepts http and https only, and needs a protocol, a host and a top-level domain. Loosening that is a breaking change: bump the minor version and write it in the changeset.
5. `isBase64` accepts the standard alphabet with `=` padding. URL-safe base64 is not accepted. The empty string is accepted, so callers that need a value check for it first.
6. `validator` is the only runtime dependency. Pass it a fixed options object built once at module load.
7. Every predicate has a test for a valid input, an invalid input and the edge that decides the contract. A change to a regex or option needs a new row in the test.
8. Never write benchmark numbers by hand. `bun run bench --write-readme` writes them from an idle machine.

## Changing this package

1. Edit `src/url.ts` or `src/base64.ts`. Keep the file's top comment true.
2. Add the matching case to `src/base64.test.ts` or `examples/validate-webhook-settings.test.ts`. The `url` predicate is covered by the example test and the smoke test in `scripts/smoke.mjs`.
3. Add a new predicate as a new `src/<name>.ts` file and a new `exports` key in `package.json`. Then run `bun ../../tooling/library/src/llms.ts --write` so `llms.txt` lists it.
4. If the change alters behaviour, add a changeset in `.changeset/`. Documentation-only changes use `patch` and the line `no demo impact: documentation and doc-example changes only, runtime behaviour unchanged`.

## Verify

```sh
bun run build
bun run typecheck
bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
