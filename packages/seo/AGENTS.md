AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/seo

SEO building blocks for web apps: metadata, robots.txt, sitemap.xml and llms.txt builders, JSON-LD components and a TanStack Start head adapter. When a doc and the code disagree, `src/index.ts`, `src/react/` and `src/tanstack-start.ts` win.

## Laws

1. The root entry has no React and no required peer. React code lives in `./react` and `./tanstack-start`.
2. The builders are pure. They return strings or `Response` objects and never throw for one bad entry.
3. A sitemap entry with an invalid `Date` is listed without `<lastmod>`.
4. Text put into XML is escaped. `JsonLdScript` escapes `<` so data cannot close the script tag.
5. `React`, `@arki/ui`, `@arki/icons` and `@tanstack/react-router` are optional peers. Only the entries that use them import them.
6. `./react` is a bundler-only entry. Do not run it unbundled in Node.
7. Types are written once and inferred everywhere.
8. A public export is never deleted because nothing uses it. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. A block that needs TanStack Router and a React app is marked `skip` with its reason.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
