AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/intl

Locale helpers: language lookups, a slug registry, dictionary loading and a TanStack Start locale provider. When a doc and the code disagree, the entry files under `src/` win.

## Laws

1. A lookup that finds nothing returns `undefined`. It does not throw.
2. `getLocalizedUrl` returns the English URL unchanged when the target locale is the default or has no slug.
3. An unknown locale falls back to the default locale's messages. Keys such as `__proto__` never match.
4. Only `@arki/intl/tanstack-start` imports React. `react` stays an optional peer.
5. This package does not format plurals, dates or numbers. That is `use-intl`'s job.
6. The built-in messages are `en` and `de`. Do not add a locale without a test for the fallback.
7. Types are written once and inferred everywhere.
8. A public export is never deleted because nothing uses it. This is a general-purpose library.
9. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
