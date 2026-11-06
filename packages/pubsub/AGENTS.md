AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/pubsub

Publish and subscribe on named channels, with a dedicated integration per backend. When a doc and the code disagree, `src/index.ts` wins.

## Laws

1. Delivery is best effort. Nothing is stored for a subscriber that was not listening. This is not a queue.
2. One contract and one conformance suite are shared. Each backend (memory, Postgres, SQLite, Redis) is its own entry, written straight against its driver.
3. A channel is 1 to 63 characters of `[a-z0-9_]`. A payload is at most 7999 bytes in UTF-8. Every backend enforces both the same way.
4. Only `pgPubSub` and `sqlitePubSub` have `publishIn`, and their types say so. A rolled-back `publishIn` is never delivered.
5. `close()` never closes the caller's database, pool or Redis client.
6. A bad call throws a `PubSubError` with a stable `code`. A Postgres `subscribe` that cannot open `LISTEN` resolves to `db.listen_unavailable` instead.
7. Every backend runs `describePubSubContract`. A new backend is not done until it passes.
8. Spans and metrics never record channel names or payloads.
9. Every error code has JSDoc with a summary, `@fix` and `@verify`.
10. Types are written once and inferred everywhere.
11. A public export is never deleted because nothing uses it. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. A block that needs a database is marked `skip` with its reason.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:pg
bun run test:redis
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```

`test:pg` and `test:redis` need Docker.
