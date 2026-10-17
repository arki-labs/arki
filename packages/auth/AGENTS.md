AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/auth

## Laws

1. One declaration, `defineAuth`, is plain data. It imports no engine and no database code, so the browser can import it.
2. App code never imports `better-auth`. The engine stays behind this package's API.
3. The supported stack is Bun, TanStack Start and oRPC. Do not add an adapter for another framework.
4. Every id comes from the table's `$defaultFn`. The engine runs with `generateId: false`.
5. Types come from the declaration and the app's user table. Do not hand-write a principal type or cast one.
6. Read the caller with `auth.principal(headers)`. A cookie and a bearer token on one request is `ARKI_AUTH_E401`.
7. Boot refuses unsafe setups with a coded `AuthError`: a weak secret, no mailer, no limiter store in production, missing workspace tables.
8. The rate limiter fails closed. A store error answers 503. Never let a request through because the limiter failed.
9. Policies never read input and never query. Input rules go in the schema. Membership checks go in the loader.
10. A security claim needs a test that runs on PGlite. Add the claim to `docs/security-evidence.md` with its test file.
11. Testing helpers throw `ARKI_AUTH_E005` in production. Never mount them there.

## Changing this package

- Definition and types: `src/definition.ts`, `src/principal.ts`. Add a type test (`*.test-d.ts`).
- Engine assembly and tables: `src/pg`. Mail and sessions tests sit next to it.
- Guards and policies: `src/orpc.ts`, `src/policies.ts`. HTTP derivers: `src/http.ts`.
- New error code: add it to `AUTH_ERROR_CODES` with JSDoc `@fix` and `@verify`, then to the Errors tables in the README and the guide.
- The README holds install, five recipes, limits and failure behaviour. Option-by-option detail goes in `docs/reference.md`.
- Run `bun ../../tooling/library/src/llms.ts --write` after an export change.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
