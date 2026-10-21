# @arki/testing for agents

Read this before you add or change a test with `@arki/testing`. The [README](../README.md) is the overview.

## The model

- The root entry is light: factories, assertions, timestamps, debug and performance. It needs no Docker.
- Heavy parts are subpaths: `containers` (Docker), `server/integration-tester` and `server/tester-builder` (`@arki/auth`, Docker), `msw` (`msw`), `e2e` (Playwright, Docker), `ai` (an Ollama daemon for judge scorers).
- `IntegrationTester` runs against a real Postgres and Redis. `withTransaction` rolls back the tester's own connection.
- `stack` and `services/*` declare real services once per app. A service starts once per run (`start`) and may give each worker its own slice (`slice`). Values that cross processes are JSON.
- The package ships TypeScript source. Run it under Vitest or Bun.

## Task map

### Build test data

Use `createFactory`, `createMany` and `createSequence`. See [Factories and assertions](factories-and-assertions.md).

```ts run
import { createFactory, createMany } from '@arki/testing';

const pointFactory = createFactory<{ x: number; y: number }>(() => ({ x: 0, y: 0 }));
const points = createMany(pointFactory, 3, index => ({ x: index }));

console.log(points.map(point => point.x).join(','));
```

```text
0,1,2
```

### Test a backend against a real database

Follow [Integration tester](integration-tester.md): `initTester`, `setupGlobalTestContainers` in `globalSetup`, then `withTransaction` in each test.

### Mock an outside HTTP API

Follow [the MSW page](msw.md) or [the recipe](recipes/mock-http-api.md).

### Score AI output

Import scorers from `@arki/testing/ai` and the matcher from `@arki/testing/ai/vitest` (or `/ai/playwright`). `expect(output).toScore(scorer)` passes or fails with the score and reason. `UnscorableError` means the scorer could not run, for example the judge model is missing.

### Run an end-to-end story against a built app

Use `@arki/testing/e2e` (`e2eConfig`, `stackSetup`, `e2eTest`, `storyFor`) with the services from `@arki/testing/stack`.

## Rules that bite

- Importing `@arki/testing/containers` without Docker fails at `setupGlobalTestContainers`. Import it only in `globalSetup`.
- `setupGlobalTestContainers` overwrites `NODE_ENV`, `AUTH_SECRET`, `VITE_URL`, `DB_URL`, `REDIS_URL` and `KV_URL`. It does not read them first.
- `withTransaction` does not roll back writes from a second connection.
- `faker` is unseeded by default. Seed it before comparing generated values.
- MSW handlers reset after every test. Add them inside the test.
- A request with no MSW handler fails the test. That is the default and the point.
- Do not weaken a check to make a flaky test pass. Find the cause.

## Errors

This package defines one error class. Everything else throws a plain `Error` or `TypeError` whose message names the field, expected value and actual value.

| Error                                                | When                                 | Fix                                                                |
| ---------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `UnscorableError`                                    | A scorer could not score the output  | Read `score.reason`. Start the judge model or fix the output shape |
| `Error: Tester not initialized. Call setup() first.` | A tester method ran before `setup()` | Call `await tester.setup()` in `beforeAll`                         |
| `Error: Expected ... ` from an assertion             | The check failed                     | Read the field, expected and actual values in the message          |

## Verify

```sh
turbo run typecheck test test:docs --filter=@arki/testing
bun ../../tooling/library/src/llms.ts --check
```
