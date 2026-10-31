# @arki/testing

Test tooling for TypeScript backends: shared Postgres and Redis containers, an integration tester with role callers and rollback, typed factories, assertions, MSW HTTP mocking, a service stack for end-to-end runs, and scorers for AI output.

## Install

```sh
bun add -D @arki/testing vitest
```

Add the peers you use. All are optional: `testcontainers`, `@testcontainers/postgresql` and `@testcontainers/redis` for containers, `msw` for HTTP mocking, `@playwright/test` for `e2e` and `ai/playwright`, `@arki/auth` for the integration tester.

## Quick start

Build test data with a factory, then check results with an assertion. This runs with no Docker and no database.

```ts from="examples/factories-and-assertions.ts#factory"
type User = { id: string; email: string; role: 'member' | 'admin' };

const userFactory = createFactory<User>(() => ({
  id: `usr_${faker.string.alphanumeric(8)}`,
  email: faker.internet.email(),
  role: 'member',
}));

const member = userFactory({ email: 'member@example.com' });
const admin = userFactory().with('role', 'admin').build();
const team = createMany(userFactory, 3, index => ({ email: `user${index}@example.com` }));
```

```ts from="examples/factories-and-assertions.ts#assertions"
const page = { items: [member, admin, ...team], total: 5, hasMore: false };

assertPaginationValid(page, { itemsCount: 5, total: 5, hasMore: false });
assertContainsId(page.items, admin.id);
await assertErrorThrown(() => Promise.reject(new Error('user not found')), /not found/);
```

`userFactory({ ... })` returns the object. `userFactory()` returns a builder. The imports are `createFactory`, `createMany`, `faker`, `assertPaginationValid`, `assertContainsId` and `assertErrorThrown` from `@arki/testing`. The full file is [examples/factories-and-assertions.ts](examples/factories-and-assertions.ts).

For a backend test against a real database, see [the integration tester](docs/integration-tester.md).

## When not to use this

- You test a browser UI in isolation. Use Vitest browser mode or Testing Library.
- You need a database other than Postgres and a store other than Redis. The containers and the integration tester assume those two.
- You want to mock a module. This package starts real services and mocks the network (MSW), not your imports.
- You need it at runtime. This is a dev dependency.

## Runtime support

Runs under Vitest 5 and Bun on Node 22.10 or newer. The package ships TypeScript source, so plain Node cannot load it from `node_modules`: use Vitest, Bun or a bundler. Not for browsers. The containers need a reachable Docker daemon.

Debug logs use the `testing:*` categories. Show them with `DEBUG_TESTS=true`.

## Public imports

The root entry loads no Docker client, no MSW and no `@arki/auth`. The rest are explicit entries.

| Import                                                                            | Gives you                                                                    | Needs                                      |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `@arki/testing`                                                                   | factories, assertions, timestamps, debug, performance                        | nothing                                    |
| `@arki/testing/assertions`, `/factories`, `/timestamps`, `/debug`, `/performance` | one part of the root                                                         | nothing                                    |
| `@arki/testing/containers`                                                        | `setupGlobalTestContainers`, `startPostgresContainer`, `startRedisContainer` | Docker, testcontainers                     |
| `@arki/testing/server/tester-builder`                                             | `initTester`                                                                 | `@arki/auth`                               |
| `@arki/testing/server/integration-tester`                                         | `IntegrationTester` and its types                                            | `@arki/auth`, Docker                       |
| `@arki/testing/msw`                                                               | `setupMswServer`, `http`, `HttpResponse`                                     | `msw`, Vitest                              |
| `@arki/testing/vitest-setup`                                                      | the Vitest test API, re-exported                                             | Vitest                                     |
| `@arki/testing/stack`, `/stack/contract`                                          | declare real services once per app                                           | Vitest                                     |
| `@arki/testing/services/*`                                                        | `postgres`, `redis`, `mailpit`, `ollama`, `http-fixtures`                    | Docker (not `ollama`, not `http-fixtures`) |
| `@arki/testing/e2e`                                                               | Playwright config, setup and story helpers for a built app                   | `@playwright/test`, Docker                 |
| `@arki/testing/ai`                                                                | scorers, `createJudge`, `defineScorer`                                       | an Ollama daemon for judge scorers         |
| `@arki/testing/ai/vitest`, `/ai/playwright`                                       | `expect(...).toScore(scorer)`                                                | Vitest or Playwright                       |

The full list with every export name is in [llms.txt](llms.txt).

## Failure behaviour

Every helper throws a plain `Error` (or `TypeError` for a wrong value type) when a check fails, so the test fails with the message. A failed assertion is the test result. Only the Ollama calls and the stack manifest return a failure value, listed below.

- Assertions name the field, the expected value and the actual value in the message.
- `IntegrationTester` methods throw `Tester not initialized. Call setup() first.` before `setup()`.
- A scorer that cannot score throws `UnscorableError`. It is never a pass, and `.not` does not turn it into one.
- `setupMswServer` fails a test that makes a request no handler matches.

These return `@arki/failure` failures instead of throwing:

| Export                 | From                  | When it is returned                                                                                |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `OllamaUnavailable`    | `@arki/testing/ai`    | Ollama did not answer: it is not running, the call timed out, or it answered with an error status. |
| `OllamaAnswerInvalid`  | `@arki/testing/ai`    | Ollama answered, but not in the asked shape: not JSON, not the schema, or not one vector per text. |
| `StackNotStarted`      | `@arki/testing/stack` | `readManifest` found `ARKI_STACK` empty: the test did not run through `playwright test`.           |
| `StackManifestInvalid` | `@arki/testing/stack` | `readManifest` found text in `ARKI_STACK` that is not the manifest `stackSetup` writes.            |

`OLLAMA_FAILURES` lists every failure a judge or an embedder call returns. A scorer turns either one into an `unscorable` score, never a pass. `READ_MANIFEST_FAILURES` lists every failure `readManifest` returns.

## Limits

- **`withTransaction` only rolls back its own connection.** Code that opens a second connection or another pool commits for real. Rows it writes stay until you call `clearTables`.
- **`setupGlobalTestContainers` sets process env.** It sets `NODE_ENV`, `AUTH_SECRET`, `VITE_URL`, `DB_URL`, `REDIS_URL` and `KV_URL`. It does not read `DB_URL` or `REDIS_URL` first, so it cannot point a run at a database you already have.
- **Default images are `postgres:16` and `redis:7-alpine`.** Pass `postgresImage` or `redisImage` to change them.
- **Without a seed, `faker` output differs on every run.** Call `faker.seed(1)` before a test that compares generated values.
- **`assertTimestampRecent` allows 10 seconds by default.** A timestamp 11 seconds old fails unless you pass `withinSeconds`.
- **MSW handlers reset after every test.** A handler added with `server.use(...)` in one test is gone in the next.

## Documentation

- [Integration tester](docs/integration-tester.md): real Postgres and Redis, role callers, rollback, seeding.
- [Factories and assertions](docs/factories-and-assertions.md): the full factory and assertion surface.
- [Debug and performance](docs/debug-and-performance.md): logging, database dumps, timing and budgets.
- [HTTP mocking with MSW](docs/msw.md): setup, patterns and why not to stub `fetch`.
- [Recipe: mock an HTTP API](docs/recipes/mock-http-api.md): one test, one command, expected output.
- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [llms.txt](llms.txt): the import map.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).
