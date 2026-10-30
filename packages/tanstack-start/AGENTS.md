AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/tanstack-start

## Laws

1. Types come from the contract and the procedure. Nothing is written at the call site of `createOrpcUtils`, `useKeysetQuery` or `useOptimisticMutation`.
2. The contract module handed to `createOrpcUtils` is browser-safe: contracts, schemas and model files only.
3. `createOrpcUtils` fails loud on a contract key it would shadow.
4. `useOptimisticMutation`'s `apply` only records edits. It is synchronous. An async `apply` throws.
5. Optimistic rollback restores only values this mutation still owns, and only in the local cache.
6. Sentry is opt-in by DSN. A missing or malformed DSN disables it without an error.
7. `./sentry/bridge` imports no `@sentry/*` package, so an app that never opts in does not bundle the SDK.
8. Entries are split by where they run. Do not import a Node entry (`./server`, `./dot`, `./config`, `./orpc/server`, `./sentry/server`) from browser code.
9. The devtools module body is gated by `import.meta.env.DEV` and renders nothing in production.
10. The Dot plugin's coded errors (`ARKI_TANSTACK_START_PLUGIN_E001`, `E002`) are never renumbered.

## Changing this package

1. Read `src/index.ts`, then the entry file for the `exports` key you change.
2. A new entry goes in the `exports` map with the condition set of its runtime. Then run `arki-llms --write`.
3. A new Dot plugin error code gets a JSDoc summary, `@fix` and `@verify`, and a row in the agent guide's Errors table.
4. A README example that cannot compile on its own carries `skip="<why>"`. Run `bun run test:docs`.
5. Add a changeset. Behaviour changes are `minor` while the version is below 1.0.

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
