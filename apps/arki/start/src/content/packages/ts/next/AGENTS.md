AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/ts

Helper types for shapes, casing and dotted paths, plus `once`, `lazyObject`, `resolveLazy` and `expectImportPure`. Read [docs/agent-guide.md](./docs/agent-guide.md) for tasks. When a doc and the code disagree, `src/index.ts` wins.

## Laws

1. A type is public only if `src/types.test-d.ts` asserts it with `expectTypeOf`. A new type without an assertion does not merge.
2. A promise in the README ("a wrong path is a compile error") is an assertion in `src/types.test-d.ts`, with `@ts-expect-error` for the negative case. Never write a negative claim only in prose.
3. Types are cheap to resolve. Measure a change to a deep helper with `bun run bench` (instantiation counts) and never write the numbers by hand.
4. No `any` in a public signature. The path helpers use `Record<string, any>` as an internal constraint only, with a reason in a comment.
5. The portable entries (`.`, `/utils`, `/prettify`) import nothing from `node:*`. Only `/testing` may.
6. Runtime code stays tiny: `once`, `resolveLazy`, `lazyObject`. It must run on Hermes, so a `Proxy` is fine and a `node:` import is not.
7. `once` does not remember a synchronous throw. `lazyObject` binds methods to the real instance. A change to either needs a test in `src/lazy.test.ts`.
8. Each helper handles plain objects and string keys. Do not grow one into a general library. Point to `type-fest` for the rest.
9. Never delete a public export to quiet a check. Libraries here are general-purpose products.

## Changing this package

1. Edit `src/utils.ts`, `src/prettify.ts` or `src/lazy.ts`.
2. Add or change the assertion in `src/types.test-d.ts` first. Watch it fail, then make it pass.
3. Run `bun run typecheck`. The assertions are checked by the compiler, not by vitest.
4. Update the README line for the helper. `bun run test:docs` compiles its blocks.
5. Add a changeset in `.changeset/`. Documentation-only changes use `patch` and the line `no demo impact: documentation and doc-example changes only, runtime behaviour unchanged`.

## Verify

```sh
bun run build
bun run typecheck
bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
