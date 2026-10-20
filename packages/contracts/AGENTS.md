AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/contracts

Shared Zod schemas for arki apps. When a doc and the code disagree, `src/index.ts`, `src/drizzle.ts` and `src/orpc.ts` win.

## Laws

1. The main entry (`src/index.ts`) stays browser-safe. It never imports Drizzle, oRPC, Node builtins or `process`.
2. Drizzle code lives in `src/drizzle.ts` only. oRPC code lives in `src/orpc.ts` only. Both peers stay optional.
3. Cursor operations and ID generation return exact canonical failures defined in `src/errors.ts`; foreign Zod validators keep their native protocol. Static definition misuse still throws `ContractsError`. Every code/definition has JSDoc, `@fix`, `@verify` and remediation.
4. Id prefixes are used exactly as given. Changing how a prefix is stored breaks rows already saved.
5. Ids come from Web Crypto. Never add a `Math.random` fallback.
6. Cursors use `btoa`, `atob` and URI coding. Never use `TextDecoder`: Hermes has none.
7. Types are written once and inferred everywhere. An operation's types come from the contract, not from a copy.
8. A public export is never deleted because nothing uses it. This is a general-purpose library.
9. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for the task you are doing.
2. Change `src/`. Add a test next to it (`*.test.ts`, and `*.test-d.ts` for types).
3. Keep README examples compiling. Blocks marked `run` must assert their result.
4. Add a changeset in `.changeset/`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
```
