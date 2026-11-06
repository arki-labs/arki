AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/offline

An offline-first toolkit: a persisted query cache, a write queue with replay, local collections, PWA helpers, status hooks and a dev panel. When a doc and the code disagree, `src/<entry>/` wins.

## Laws

1. There is no root entry. Each capability is its own subpath, so an app installs and bundles only what it uses.
2. Every queued procedure must be safe to run twice with the same result. Declare it once on the contract with `offlineSafe`.
3. A queued write replays only under the account that made it. The queue stores `actorId()` with each entry and checks it again before every send.
4. Failures are returned as values with a stable `offline.*` code. Nothing is thrown for a storage or transport fault.
5. Corrupt stored queue bytes are preserved and rejected. They never look like an empty queue.
6. An unconfirmed local write or remote effect is a distinct failure. Reconcile with the carried identity before you repeat it.
7. Spans carry only canonical failure codes. IDs, inputs, actors and causes stay out.
8. `./query`, `./mutations`, `./preset`, `./status` and `./devtools` are web-only. `./pwa` is browser-only. Do not import them in React Native.
9. The dev panel costs nothing in production.
10. Every error code has JSDoc with a summary, `@fix` and `@verify`.
11. Types are written once and inferred everywhere.
12. A public export is never deleted because nothing uses it. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. A block that needs an app, a database or a service worker is marked `skip` with its reason.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
