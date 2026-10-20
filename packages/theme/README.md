# @arki/theme

Light / dark / system theme for ARKI React apps: a provider, a hook, and a tiny inline script that applies the stored theme before first paint so there is no flash.

## Install

```sh
bun add @arki/theme react
```

`react` 19 is a peer dependency.

## Quick start

Put the script in `<head>`, then wrap the app in the provider. Any component below can read and set the theme.

```tsx
import type { ReactNode } from 'react';

import { ThemeProvider, useTheme } from '@arki/theme';
import { themeScript } from '@arki/theme/script';

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript() }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return <button onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{theme}</button>;
}
```

The choice is stored in `localStorage['theme']` (`THEME_STORAGE_KEY`). It is applied as the `dark` class on `<html>`, which is what the `@arki/design-systems` tokens respond to.

## When not to use this

- You need more than a class or attribute on `<html>`, such as per-subtree themes or a theme stored in a cookie. The provider sets one value for the whole document.
- You render on the server and need the theme known before the page is sent. This package reads `localStorage` in the browser, so the server always renders the default.
- You do not use React. The script works anywhere, but the provider and hook are React only.

## Runtime support

Source-distributed: ships TypeScript/TSX, needs a bundler (Vite with the TanStack Start stack).

## Public imports

- `@arki/theme`: `ThemeProvider`, `useTheme`, and the types `Theme`, `ResolvedTheme`, `ThemeProviderProps`, `UseThemeReturn`.
- `@arki/theme/script`: `themeScript`, `themeDetectionFn`, `THEME_STORAGE_KEY`, and the type `ThemeDetectionOptions`.

## Failure behaviour

Nothing here throws.

- `useTheme()` outside a `ThemeProvider` returns a no-op default: `theme` is `undefined` and `setTheme` does nothing. Server rendering and tests work without a provider.
- If `localStorage` is blocked (private mode, a strict browser setting), reads return nothing and writes are dropped. The theme then lasts until the page reloads.
- A stored value that is not in `themes` is replaced by `defaultTheme`.
- If system preference detection is missing or throws, both the provider and inline script resolve `system` to `light`. A blocked media query subscription keeps the detected preference.

## Limits

- The server renders `defaultTheme`. The inline script fixes the page before paint, but React state first matches the server render. Put `suppressHydrationWarning` on `<html>`.
- The script and the provider are separate. Give both the same `storageKey`, `attribute`, `themes` and `defaultTheme`, or the page flashes.
- `setTheme` only accepts a name in `themes`. Boundary: with the default themes, `setTheme('sepia')` stores `system`, not `sepia`. Add `'sepia'` to `themes` first.

```ts run expect
import { themeScript } from '@arki/theme/script';

const script = themeScript({ storageKey: 'app-theme', themes: ['light', 'dark', 'sepia'] });
console.log(script.includes('"storageKey":"app-theme"'), script.includes('"sepia"'));
```

```text
true true
```

<!-- bench:start -->
## Benchmarks

Bundle size of the theme provider and hook in @arki/theme against next-themes, the most used light/dark/system theme library for React.

Measured on Node 22.13.1 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.0.1 (mitata 1.0.34) · publish, seed 1592639052 · commit 34146416b3 (uncommitted changes) · 2026-10-13.

Versions: @arki/bench 0.0.1 · @arki/theme 0.2.1 · mitata 1.0.34 · next-themes 0.4.6.

### ThemeProvider + useTheme

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/theme |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/theme** | 0.2.1 | 1.07 kB | 932 B | 2.46 kB | 1.5 kB | baseline |
| @arki/theme (with script) (variant) | 0.2.1 | 1.34 kB | 1.18 kB | 3.45 kB | 1.5 kB | 1.2× larger [1.2–1.2] |
| next-themes | 0.4.6 | 1.5 kB | 1.32 kB | 3.35 kB | — | different contract: provider carries its own no-flash script; props and storage format differ |

### No-flash init script

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/theme/script |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/theme/script** | 0.2.1 | 488 B | 416 B | 991 B | 1 kB | baseline |

The script is generated at build or render time on the server, and the string is inlined in HTML.

**Notes**

- next-themes injects its no-flash script from inside its provider, so that script is already in its row. @arki/theme exports the script separately (`@arki/theme/script`) so you can inline it in your HTML head. The `with script` row adds it for a like-for-like size; next-themes still differs in API and behaviour, so it is not ranked.
- The script is built on the server and inlined in HTML. It is not part of the client bundle if you only call it on the server.

Reproduce: `bunx arki-bench run --profile publish` in the package directory.

<!-- bench:meta {"schema":1,"suite":"@arki/theme","specHash":"176520ffefeedbeb","profile":"publish","date":"2026-10-13T08:58:51.936Z","harness":"0.0.1"} -->
<!-- bench:end -->

## Documentation

- [docs/agent-guide.md](./docs/agent-guide.md): the model, a task map, the rules that bite, and how to verify.
- [llms.txt](./llms.txt): the short form for agents.

## Support

Report bugs and questions at <https://github.com/arki-labs/arki/issues>.

## License

MIT. See [LICENSE](./LICENSE).
