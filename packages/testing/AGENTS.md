AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/testing

## Laws

1. The root entry (`src/index.ts`) loads no Docker client, no MSW and no `@arki/auth`. Anything that needs one is its own subpath export. Keep `src/root-entry-light.test.ts` green.
2. Source-distributed: `exports` point at `src/*.ts`, with `dist/src/*.d.ts` for types. Never add a build step the exports depend on.
3. Optional peers stay optional. Import `testcontainers`, `msw`, `@playwright/test` and `@arki/auth` only from the subpaths that need them.
4. A failed check throws an `Error` that names the field, the expected value and the actual value. Assertions never return a failure value.
5. Never return a scorer pass when a scorer could not score. Throw `UnscorableError`. `.not` must not turn it into a pass.
6. No `any`, no `@ts-ignore`, no unsafe cast. `src/no-any.test.ts` enforces it.
7. Validate unknown values with a Standard Schema (`assertMatchesSchema`, `itemSchema`). Do not hand-write a guard.
8. A new primitive lands after its second real use. The first use stays inline in the consumer's test.
9. Every container this package starts carries the `arki-testing-run` label (`src/services/labels.ts`), so a leak is findable.
10. Mock the network with MSW, not with a stubbed `fetch`.
11. Log through `getLogger('testing:...')`, never `console.log` in new code.

## Changing this package

- New helper: add it to the right file, export it from the entry that fits, and add a focused test next to it. Tiny re-exports need no test.
- New subpath: add it to `package.json` `exports` (with `types`, `import`, `node`), put a one-line `/** ... */` comment at the top of the entry file, then run `bun ../../tooling/library/src/llms.ts --write`.
- New error class: JSDoc `@fix` and `@verify` on it.
- External deps go in the root `package.json` catalog `testing`, and here as `catalog:testing`.
- Keep `README.md`, `llms.txt`, `docs/agent-guide.md` and the pages under `docs/` in step. Every fence in them is compiled or skipped with a reason.
- Do not add `DB_URL` or `REDIS_URL` reuse to `setupGlobalTestContainers` without a test: today it sets both and never reads them.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
