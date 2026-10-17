AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/live

## Laws

1. A hint says only which table (and which granted keys) changed. Never put row data or a raw txid on the wire. Data always comes from a normal, authorized refetch.
2. A grant filters a hint before the stream's batch window and queue, never after. Resume or reset depends on the cursor's age only. Otherwise a hidden write changes what a client can observe.
3. Never make a trigger function `SECURITY DEFINER`. The library never runs DDL. Apps apply `liveMigration` themselves.
4. No `async function*` in `src/`: Hermes cannot compile it. Build streams with `pullIterator` (`src/iterator.ts`), and give each one a cleanup that runs on `return()`.
5. Every entry except the root keeps its peers optional. `bun run test:peers` proves each entry loads with them absent.
6. Logs go through `src/debug.ts` (`arki:live:*`), at debug level for lifecycle.
7. Errors are thrown `LiveError` values with a stable `code` and a `remediation`. Match on the code, never on the message. A reset is not an error.
8. Do not promise ordering inside a frame, agreement between queries or exactly-once hints. The README's Limits section says what is promised.
9. Raw transaction ids never leave the hub. Frames carry receipts (`liveReceipts`).
10. Every code in `LIVE_ERROR_CODES` has a JSDoc summary, `@fix` and `@verify`.

## Changing this package

Where things live:

| Part                                                     | Files                                             |
| -------------------------------------------------------- | ------------------------------------------------- |
| Wire schemas, cursors, errors                            | `src/schema.ts`, `src/cursor.ts`, `src/errors.ts` |
| Hub (numbers hints, replay ring, one feed per stream)    | `src/hub.ts`, `src/replay.ts`                     |
| Postgres source, trigger migration, `verifyLiveTriggers` | `src/pg/`                                         |
| `live()` meta, `snapshot()`                              | `src/drizzle/`                                    |
| `liveRead()`, `liveManifest()`                           | `src/orpc/`                                       |
| SSE endpoint                                             | `src/http.ts`                                     |
| Stream client, React provider                            | `src/client.ts`, `src/react.ts`                   |
| Dot plugin (`liveQueries`)                               | `src/dot.ts`                                      |

1. Read [docs/agent-guide.md](./docs/agent-guide.md) first. When a doc and the code disagree, `src/index.ts` wins.
2. A change to a guarantee needs a test in the failure matrix (`src/tests/failure.pg.test.ts`).
3. A new error code goes in `LIVE_ERROR_CODES` with a JSDoc summary, `@fix` and `@verify`, and a row in the README's Failure behaviour table.
4. Add a changeset. Behaviour changes are `minor` while the version is below 1.0.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
HERMES_BIN=/path/to/hermes bun run test:runtimes -- --require-all
bun run test:peers && bun run test:pack
bun run test:e2e   # Playwright and Postgres in Docker
bun ../../tooling/library/src/llms.ts --check
```
