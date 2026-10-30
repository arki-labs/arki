AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/admin

## Laws

1. Every failure the package raises on purpose is an `AdminError` with a code from `ADMIN_ERROR_CODES`. Match on the code, never on the message.
2. Never renumber an `ARKI_ADMIN_E0xx` code.
3. A module refuses a request with `moduleError(code, status, message, remediation)`. The status is 400 to 599.
4. Server error messages and private causes never reach the wire. A plain `Error` from app code answers `ARKI_ADMIN_E015`.
5. With none of the four `FOREMAN_*` keys set, `/api/foreman/*` answers 404. With some set, construction throws `ARKI_ADMIN_E014`.
6. An execute runs at most once per `executionId`. The receipt is claimed before the action runs and settled before the response is sent.
7. `FOREMAN_WRITES=on` needs a receipt store that can take a claim. Without one, an execute is refused with `ARKI_ADMIN_E017`.
8. A read, action and signal take any Standard Schema. The manifest JSON Schema comes from the schema itself.
9. A manifest never ships code. A panel names a renderer that Foreman bundles.
10. The root entry `@arki/admin` has no secrets and no Node built-ins.
11. Every error code has a JSDoc summary, `@fix` and `@verify`.

## Changing this package

1. Read `src/errors.ts` (codes), `src/module.ts` (modules) and `src/dispatcher.ts` (the request handler) first.
2. A new error code goes in `ADMIN_ERROR_CODES` with a JSDoc summary, `@fix` and `@verify`, and a row in the agent guide's Errors table.
3. A new entry point goes in the `exports` map. Then run `arki-llms --write` in this folder.
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
