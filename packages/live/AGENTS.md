# @arki/live — rules for agents

Live queries on your own Postgres. Read [docs/agent-guide.md](./docs/agent-guide.md) first: it has the model, a task map and the full list of rules. When a doc and the code disagree, `src/index.ts` wins.

## Where things live

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

## Rules

1. A hint says only which table (and which granted keys) changed. Never put row data or a raw txid on the wire. Data always comes from a normal, authorized refetch.
2. A grant filters a hint before the stream's batch window and queue, never after. Resume or reset depends on the cursor's age only. Otherwise a hidden write changes what a client can observe.
3. Never make a trigger function `SECURITY DEFINER`. The library never runs DDL; apps apply `liveMigration` themselves.
4. No `async function*` in `src/`: Hermes cannot compile it. Build streams with `pullIterator` (`src/iterator.ts`), and give each one a cleanup that runs on `return()`.
5. Every entry except the root keeps its peers optional. `bun run test:peers` proves each entry loads with them absent.
6. Logs go through `src/debug.ts` (`arki:live:*`), at debug level for lifecycle.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
HERMES_BIN=/path/to/hermes bun run test:runtimes -- --require-all
bun run test:peers && bun run test:pack
bun run test:e2e   # Playwright and Postgres in Docker
```
