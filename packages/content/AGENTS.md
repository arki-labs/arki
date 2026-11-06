AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/content

Feed parsing and writing, post search and sorted content collections. When a doc and the code disagree, `src/index.ts` and `src/rss/index.ts` win.

## Laws

1. `parseFeed` returns a failure. It never throws on bad input.
2. `parseFeed` refuses DOCTYPE and entity declarations. Do not add a way around it.
3. The default limits are 10 MiB of text and 10,000 items. A change to a default is a breaking change.
4. The package has no framework dependency. Do not import React or a router.
5. `contentQueries` returns sorted copies. It never mutates the input collections.
6. Every error code has JSDoc with a summary, `@fix` and `@verify`.
7. Types are written once and inferred everywhere.
8. A public export is never deleted because nothing uses it. This is a general-purpose library.
9. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. A block marked `skip` needs a reason.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
