# @arki/theme

Light / dark / system theme for ARKI React apps: a provider, a hook, and a tiny inline script that applies the stored theme before first paint so there is no flash.

> **Source-first package.** Ships TypeScript source as the runtime entry plus `.d.ts`. Your bundler (Vite, TanStack Start, Next.js, Bun) compiles it.

## Installation

```sh
bun add @arki/theme react
```

Peer dependency: `react` 19.

## Usage

Render the no-flash script in `<head>`, then wrap the app:

```tsx
import { ThemeProvider, useTheme } from '@arki/theme';
import { themeScript } from '@arki/theme/script';

// In your document head (server-rendered):
<script dangerouslySetInnerHTML={{ __html: themeScript() }} />;

// Around the app:
<ThemeProvider>
  <App />
</ThemeProvider>;

// Anywhere below:
function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return <button onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{theme}</button>;
}
```

The theme is stored under `localStorage['theme']` (`THEME_STORAGE_KEY`) and applied as the `dark` class / `data-theme` attribute, which is what `@arki/design-systems` tokens respond to.

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

## License

MIT
