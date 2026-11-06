# Agent guide: @arki/code-editor

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/editor.tsx`, `src/themes.ts` and `src/theme-picker.tsx` win.

## The model

1. `@arki/code-editor/editor` exports `CodeEditor`, a controlled CodeMirror 6 editor. It takes `value` and `onChange`.
2. `@arki/code-editor/themes` exports 13 light and dark themes as plain data: `themes`, `themeMap` and `getTheme(id)`.
3. `@arki/code-editor/theme-picker` exports `ThemePicker`, a controlled popover with `value` and `onChange`.
4. The editor reads no global state. The app stores the theme id and passes `getTheme(id).extension` as `theme`.
5. Highlighting exists for `json`, `yaml`, `xml`, `markdown`, `typescript`, `javascript`, `css`, `html`, `python` and `sql`.

## Task map

### Show an editor

1. `<CodeEditor value={value} onChange={setValue} language="json" theme={getTheme(id).extension} />`.
2. Add `lineNumbers` for a gutter. Add `readOnly` for a viewer.

### Let the user pick a theme

1. Keep the theme id in your own state.
2. Render `<ThemePicker value={id} onChange={setId} />`.
3. Pass `getTheme(id).extension` to the editor.

### List themes without React

1. Import from `@arki/code-editor/themes`. It runs on Node, Bun and Deno.
2. Filter `themes` by `variant` (`'light'` or `'dark'`).

## Rules that bite

- The editor does not store the theme. You pass it in every time.
- `getTheme` returns `github-dark` for an unknown id.
- `toml` and `text` show without highlighting. `text` is the default language.
- Autocompletion, folding and search keys are off. Lines wrap.
- History and closing brackets are off when `readOnly` is set.
- Build with a bundler such as Vite. The components import TypeScript source.

## Errors

This package defines no error codes and returns no failures.

| Situation                     | Result                            | What to do                            |
| ----------------------------- | --------------------------------- | ------------------------------------- |
| Unknown theme id              | `getTheme` returns `github-dark`. | Check the id against `EditorThemeId`. |
| Language with no highlighting | The text shows without colors.    | Pick a language from the list above.  |

## Verify

```sh
bun run build && bun run typecheck && bun run lint
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
