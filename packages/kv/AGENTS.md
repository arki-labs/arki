AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/kv

A Redis key-value store and rate limiter, with a Dot plugin. When a doc and the code disagree, `src/index.ts` and `src/dot.ts` win.

## Laws

1. A TTL on `KV` is in seconds. A TTL on the idempotency cache is in milliseconds. Never mix them in one API.
2. A missing Redis must not crash the rate limiter. It falls back to memory.
3. The Redis idempotency cache checks the owner token in one Lua script. A slow request whose key was taken by another must not touch the new entry.
4. `@arki/http` and `@arki/dot` stay optional peers. The root entry never imports them.
5. Every error code has JSDoc with a summary, `@fix` and `@verify`.
6. Logs go through `src/debug.ts`. Never `console.log`. Never log a URL with credentials.
7. Types are written once and inferred everywhere.
8. A public export is never deleted because nothing uses it. This is a general-purpose library.
9. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. A block that needs a live Redis is compiled and not run.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
