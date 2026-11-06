AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/content-react

React components for content pages and the `useSearch` hook. When a doc and the code disagree, `src/index.ts` wins.

## Laws

1. `useSearch` returns `SearchUnavailable` or `SearchResponseMalformed` as values. It never throws for a bad response.
2. `useSearch` aborts a request still in flight when a new one starts. An abort is not shown to the user as an error.
3. The package has one entry, `@arki/content-react`. It is bundler-only because it imports `@arki/ui` and `@arki/icons`, which ship TypeScript source.
4. It renders what `@arki/content-build` produces. It does not compile MDX and does not build a search index.
5. `react` stays a peer dependency (18 or 19).
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
