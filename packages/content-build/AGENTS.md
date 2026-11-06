AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/content-build

The build-time content pipeline: content-collections config, preset collections, a Vite plugin and the `arki-content` CLI. When a doc and the code disagree, `src/config.ts`, `src/presets.ts`, `src/vite.ts` and `src/cli.ts` win.

## Laws

1. A content build runs from the folder that holds `content.config.ts`. A build from another folder fails with a clear message.
2. `vite build` fails on any broken content file. `vite dev` only reports it.
3. The build never fetches embeds. Only `arki-content snapshot` fetches, and it writes the result under `src/content/.embeds/` for the app to commit.
4. `compileMarkdown` is plain markdown, not MDX. Raw HTML is sanitized unless the caller passes `trustedHtml: true`.
5. `vite` stays an optional peer. Only the `./vite` entry imports it.
6. `arki-content` exit codes are 0 ok, 1 a content or fetch failure, 2 wrong usage.
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
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
