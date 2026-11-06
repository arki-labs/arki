AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/fs

File storage adapters (S3, R2, local) and the files table on Postgres or SQLite. When a doc and the code disagree, the entry files named in `package.json` `exports` win.

## Laws

1. No URL is returned before its pending row commits. A row is `ready` only after the server read the object and size and type matched.
2. Keys are derived by the server from the row. A client never picks one.
3. Expected outcomes are returned failures. Only static bad configuration throws `FileStorageError`.
4. `FileUnavailable` is one failure for missing and denied files, so a caller cannot probe which files exist.
5. Storage I/O never runs inside a database transaction. `fileStorage` takes the root database, never a transaction.
6. A dispatched write with no confirmed outcome is `StorageWriteUncertain`. It is never retried automatically and never reported as success.
7. `exists()` is never proof that an object is missing. A `deleting` row is never set back to `ready`.
8. Logs and telemetry never carry paths, keys, URLs, bytes, credentials or owner ids.
9. Every error code has JSDoc with a summary, `@fix` and `@verify`.
10. Types are written once and inferred everywhere.
11. A public export is never deleted because nothing uses it. This is a general-purpose library.
12. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. The server examples live in `examples/files/` and are type-checked by the package.
4. Add a changeset, and an upgrade note under `docs/upgrades/` for a breaking change.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:pg
bun ../../tooling/library/src/llms.ts --check
```
