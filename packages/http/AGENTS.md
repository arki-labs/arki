AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/http

Typed HTTP: route contracts as data, Standard Schema validation, a fetch engine and a Dot driver. When a doc and the code disagree, `src/index.ts` and `src/contract.ts` win.

## Laws

1. A contract is plain data at module scope. A handler is bound later. Never put a handler inside a contract.
2. Any Standard Schema works. Never import a schema library into the core (`zod` is only a dev and doc dependency).
3. No Hono type appears in the public API. Routing stays an implementation detail.
4. Every failure on the wire is a coded envelope. A new code goes in `HTTP_ERROR_CODES` or `HTTP_PLUGIN_ERROR_CODES` with JSDoc (summary, `@fix`, `@verify`) and a row in the README error table.
5. `@arki/http/client` imports nothing from Node. It must run on Hermes and in browsers.
6. `@arki/http/public-fetch` is a security boundary. It checks the address after DNS and after every redirect. Never weaken it.
7. Handlers close over real services. There is no service locator.
8. Messages are redacted in production. Never put a secret or a private path in an error message.
9. A public export is never deleted because nothing uses it. This is a general-purpose library.
10. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test in `src/tests/`. Add a type test when a type changes.
3. Keep README blocks compiling. A block that needs the app's own contracts carries a `skip` reason.
4. Update the error table and the guide when you add a code.
5. Add a changeset.
6. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
