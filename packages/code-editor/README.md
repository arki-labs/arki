# @arki/code-editor

A [CodeMirror 6](https://codemirror.net/) editor for React. It highlights 10 languages and ships 13 light and dark themes with a small theme picker. The editor reads no global state. You pass the theme in.

## Install

```sh
npm install @arki/code-editor
# or
bun add @arki/code-editor
```

`react` (18 or 19) is a peer. The components import `@arki/ui` and `@arki/icons`, which ship TypeScript source, so build with a bundler such as Vite.

## Quick start

```tsx skip="needs a React DOM and a bundler"
import { CodeEditor } from '@arki/code-editor/editor';
import { getTheme } from '@arki/code-editor/themes';

export function JsonField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return <CodeEditor value={value} onChange={onChange} language="json" theme={getTheme('github-dark').extension} lineNumbers />;
}
```

The themes are plain data, so this part runs anywhere:

```ts
import { getTheme, themes } from '@arki/code-editor/themes';

export const dark = themes.filter(theme => theme.variant === 'dark').map(theme => theme.id);
export const label = getTheme('nord').label; // 'Nord'
```

## Public imports

| Import | What |
| --- | --- |
| `@arki/code-editor/editor` | `CodeEditor` and the types `CodeEditorProps` and `CodeEditorLanguage`. Props: `value`, `onChange`, `language`, `readOnly`, `placeholder`, `className`, `ariaLabel`, `theme`, `lineNumbers`. |
| `@arki/code-editor/themes` | `themes`, `themeMap`, `getTheme(id)` and the types `EditorThemeId`, `ThemeConfig`, `ThemeVariant`. `getTheme` falls back to `github-dark` for an unknown id. |
| `@arki/code-editor/theme-picker` | `ThemePicker` (a controlled palette popover: `value`, `onChange`, `className`), plus `ThemeGroup` and `ThemeSwatch`. |

## When not to use this

- You need a full IDE with language servers. This is a text editor with syntax colors.
- You do not use React. Use CodeMirror directly.

## Runtime support

Browsers, through a bundler. The `themes` entry also loads under Node, Bun and Deno.

## Failure behaviour

An unknown theme id returns the `github-dark` theme.

## Limits

Highlighting for `json`, `yaml`, `xml`, `markdown`, `typescript`, `javascript`, `css`, `html`, `python` and `sql`. `toml` and `text` are accepted and shown without highlighting.
