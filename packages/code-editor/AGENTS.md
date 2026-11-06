AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/code-editor

A CodeMirror 6 editor for React with 13 themes and a theme picker. When a doc and the code disagree, `src/editor.tsx`, `src/themes.ts` and `src/theme-picker.tsx` win.

## Laws

1. The editor reads no global state. The app passes the theme in through the `theme` prop.
2. `getTheme` falls back to `github-dark` for an unknown id. It does not throw.
3. `toml` and `text` render without highlighting. Do not claim highlighting for them.
4. The `themes` entry has no React import, so it loads on Node, Bun and Deno.
5. `react` stays a peer dependency (18 or 19). The components need a bundler because `@arki/ui` and `@arki/icons` ship TypeScript source.
6. Types are written once and inferred everywhere.
7. A public export is never deleted because nothing uses it. This is a general-purpose library.
8. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`.
3. Keep README blocks compiling. The React block is marked `skip` with a reason.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
