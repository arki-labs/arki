# @arki/ui

React component library for ARKI apps: Base UI primitives styled with Tailwind v4 semantic tokens. Forms, overlays, navigation, data display and charts. One import per component.

## Install

```sh
bun add @arki/ui @arki/design-systems react react-dom
```

`react` and `react-dom` 19 are peer dependencies. `@arki/design-systems` supplies the tokens the components read, and `@arki/ui/theme` sets light and dark mode.

## Quick start

Pick one design system and let Tailwind scan the component sources.

```css
/* src/styles/global.css */
@import 'tailwindcss';
@import '@arki/design-systems/atelier/fonts.css';
@import '@arki/design-systems/atelier/tokens.css';
@import '@arki/design-systems/atelier/theme-bridge.css';

/* Adjust the path to where @arki/ui is installed. */
@source '../node_modules/@arki/ui/src';
```

Then import each component from its own subpath.

```tsx
import { Button } from '@arki/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@arki/ui/card';
import { cn } from '@arki/ui/cn';

export function Example() {
  return (
    <Card className={cn('max-w-md')}>
      <CardHeader>
        <CardTitle>Tidal Mug</CardTitle>
      </CardHeader>
      <CardContent>
        <Button>Add to cart</Button>
      </CardContent>
    </Card>
  );
}
```

## When not to use this

- Your app does not use Tailwind v4. The components are styled with Tailwind classes and have no stylesheet of their own.
- You need a headless library to style yourself. Use `@base-ui/react` directly. This package is the styled layer on top of it.
- You mix design systems in one app. These components read one set of tokens (see `@arki/design-systems`).
- You build for React Native. Use `@arki/native-ui`.

## Runtime support

Source-distributed: ships TypeScript/TSX, needs a bundler (Vite with the TanStack Start stack).

## Public imports

There is no root import. Every component is its own subpath: `@arki/ui/button`, `@arki/ui/dialog`, `@arki/ui/select`, `@arki/ui/table`, `@arki/ui/chart`. [`llms.txt`](./llms.txt) lists all of them with their names.

| Group | Subpaths |
| --- | --- |
| Actions | `button`, `toggle`, `toggle-group`, `toolbar`, `control-group` |
| Forms | `form`, `input`, `input-base`, `input-otp`, `textarea`, `textarea-with-autosize`, `select`, `checkbox`, `radio-group`, `switch`, `slider`, `label`, `date-picker`, `color-picker`, `math-input`, `complex-input` |
| Overlays | `dialog`, `alert-dialog`, `drawer`, `sheet`, `popover`, `hover-card`, `tooltip`, `command`, `sonner` (toasts) |
| Menus and navigation | `dropdown-menu`, `context-menu`, `menubar`, `navigation-menu`, `breadcrumb`, `pagination`, `tabs`, `sidebar` |
| Layout and surfaces | `card`, `glass-card`, `panel`, `surface`, `separator`, `scroll-area`, `resizable`, `tool-panels`, `aspect-ratio`, `accordion`, `collapsible` |
| Data display | `table`, `chart`, `badge`, `avatar`, `alert`, `callout`, `progress`, `skeleton`, `spinners`, `timeline`, `carousel`, `calendar`, `katex` |
| Helpers | `cn`, `design-system`, `slot`, `as-child`, `scroll-to-top` |
| Theme | `theme` (`ThemeProvider`, `useTheme`), `theme/script` (`themeScript`, `themeDetectionFn`, `THEME_STORAGE_KEY`) |
| Hooks | `hooks/debounce`, `hooks/local-storage`, `hooks/media-query`, `hooks/hotkeys`, `hooks/copy-to-clipboard`, `hooks/timeout`, `hooks/toggle`, `hooks/pagination`, `hooks/async-memo`, `hooks/is-client`, `hooks/long-press`, `hooks/touch`, `hooks/use-viewport`, `hooks/use-swipe-gesture`, `hooks/use-touch-feedback` |

## Failure behaviour

Components do not return failure values. Mistakes in how you compose them show up in three ways.

- Some compound parts need their parent. These hooks throw a plain `Error` when the parent is missing: `useFormField` (inside `FormField`), `useSidebar` (inside `SidebarProvider`), and the hooks for `Chart`, `Carousel`, `ControlGroup` and `Timeline`. Fix the tree; do not catch the error.
- A missing token gives a wrong colour, not an error. If a page looks unstyled, check the `@source` line and the token imports first.
- `Toaster` reads the theme from `@arki/ui/theme`. Without a `ThemeProvider` it uses `system`.
- The theme never throws. `useTheme()` outside a `ThemeProvider` returns `theme: undefined` and a `setTheme` that does nothing. A blocked `localStorage` drops writes, so the theme lasts until reload. A stored name not in `themes` becomes `defaultTheme`. If system preference detection is missing or throws, `system` resolves to `light`.
- Hooks under `hooks/*` do not throw for bad input. `useAsyncMemo` returns `undefined` (or your `initial`) until the promise resolves; a rejected promise is not caught, so catch inside the factory. On the server, `useMediaQuery` and the `useIs*` hooks return `false`, and `useViewport` returns a 1024 by 768 desktop.

## Limits

- Tailwind only sees classes it can scan. If `@source` does not point at the installed `@arki/ui/src`, components render with no styling and no error.
- Pick one design system per app. Boundary: loading `atelier` tokens and `workbench` tokens in one stylesheet makes the later file win for every shared name, so components mix two palettes.
- `katex` does not load KaTeX's stylesheet. Import `katex/dist/katex.min.css` yourself, or maths renders unstyled.
- Imports must name a subpath. `import { Button } from '@arki/ui'` fails: the package has no root entry.
- Some components rely on browser APIs (`matchMedia`, `ResizeObserver`). Render them on the client; in tests use a DOM environment.
- `useViewport` calls anything under 640px mobile and under 1024px tablet. `useIsMobile` calls anything under 768px mobile. Boundary: at 700px, `useViewport().isMobile` is `false` and `useIsMobile()` is `true`. Pick one family per component.
- `useAsyncMemo` drops a result when its dependencies change before it resolves. It does not cancel the request.
- The server renders `defaultTheme`. `themeScript()` fixes the page before paint, but React state first matches the server render. Put `suppressHydrationWarning` on `<html>`.
- The theme script and `ThemeProvider` are separate. Give both the same `storageKey`, `attribute`, `themes` and `defaultTheme`, or the page flashes.
- `setTheme` only accepts a name in `themes`. Boundary: with the default themes, `setTheme('sepia')` stores `system`, not `sepia`. Add `'sepia'` to `themes` first.

```ts run expect
import { themeScript } from '@arki/ui/theme/script';

const script = themeScript({ storageKey: 'app-theme', themes: ['light', 'dark', 'sepia'] });
console.log(script.includes('"storageKey":"app-theme"'), script.includes('"sepia"'));
```

```text
true true
```

## Design-system rules

1. Style with semantic classes: `bg-background`, `bg-card`, `text-muted-foreground`, `border-border`.
2. One design system per app: `atelier`, `workbench` or `arena`. Never mix them.
3. App-specific colours get new token names. Do not redefine a shared name.
4. If a component needs a token the contract does not have, propose the smallest extension and get confirmation before you change `@arki/design-systems`.

<!-- bench:start -->
## Benchmarks

Bundle size of the same components from @arki/ui and from popular React component libraries. Mantine, MUI and Radix Themes are the common full-featured choices.

Measured on Node 22.13.1 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.0.1 (mitata 1.0.34) · publish, seed 1592639052 · commit 34146416b3 (uncommitted changes) · 2026-10-13.

Versions: @arki/bench 0.0.1 · @arki/ui 0.1.4 · @mantine/core 7.17.4 · @mui/material 9.5.0 · @radix-ui/themes 3.3.0 · mitata 1.0.34.

### Button, JavaScript only

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/ui |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/ui** | 0.1.4 | 12.9 kB | 11.5 kB | 39.4 kB | 14.5 kB | baseline |
| @mantine/core | 7.17.4 | 12.1 kB | 10.7 kB | 40.5 kB | — | different contract: ships a separate stylesheet that this row does not count |
| @mui/material | 9.5.0 | 37.7 kB | 33.6 kB | 110 kB | — | different contract: styles are injected at runtime by Emotion (CSS-in-JS), not a stylesheet |
| @radix-ui/themes | 3.3.0 | 5.32 kB | 4.79 kB | 17 kB | — | different contract: ships a separate stylesheet that this row does not count |

### Dialog, JavaScript only

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/ui |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/ui** | 0.1.4 | 32 kB | 28.6 kB | 97.6 kB | 35.5 kB | baseline |
| @mantine/core | 7.17.4 | 20.5 kB | 18.2 kB | 66.4 kB | — | different contract: ships a separate stylesheet that this row does not count |
| @mui/material | 9.5.0 | 40 kB | 35.4 kB | 117 kB | — | different contract: styles are injected at runtime by Emotion (CSS-in-JS), not a stylesheet |
| @radix-ui/themes | 3.3.0 | 19.3 kB | 17.3 kB | 58.3 kB | — | different contract: ships a separate stylesheet that this row does not count |

### Form set (Button, Input, Select, Checkbox), JavaScript only

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/ui |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/ui** | 0.1.4 | 57.5 kB | 50.4 kB | 169 kB | 63.5 kB | baseline |
| @mantine/core | 7.17.4 | 43 kB | 38 kB | 140 kB | — | different contract: ships a separate stylesheet that this row does not count |
| @mui/material | 9.5.0 | 68.5 kB | 59.5 kB | 213 kB | — | different contract: styles are injected at runtime by Emotion (CSS-in-JS), not a stylesheet |
| @radix-ui/themes | 3.3.0 | 43.5 kB | 38.4 kB | 133 kB | — | different contract: ships a separate stylesheet that this row does not count |

### Button, complete styled

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/ui + Tailwind CSS |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/ui + Tailwind CSS** | 0.1.4 | 17 kB | 15 kB | 58.2 kB | 18.5 kB | baseline |
| @mantine/core + styles.css | 7.17.4 | 44.3 kB | 36.5 kB | 338 kB | — | 2.6× larger [2.6–2.6] |
| @mui/material (Emotion) | 9.5.0 | 37.7 kB | 33.6 kB | 110 kB | — | 2.2× larger [2.2–2.2] |
| @radix-ui/themes + styles.css | 3.3.0 | 86.1 kB | 54.4 kB | 731 kB | — | 5.1× larger [5.1–5.1] |

### Dialog, complete styled

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/ui + Tailwind CSS |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/ui + Tailwind CSS** | 0.1.4 | 37 kB | 32.9 kB | 121 kB | 41 kB | baseline |
| @mantine/core + styles.css | 7.17.4 | 52.7 kB | 44.1 kB | 363 kB | — | 1.4× larger [1.4–1.4] |
| @mui/material (Emotion) | 9.5.0 | 40 kB | 35.4 kB | 117 kB | — | 1.08× larger [1.08–1.08] |
| @radix-ui/themes + styles.css | 3.3.0 | 100 kB | 66.9 kB | 773 kB | — | 2.7× larger [2.7–2.7] |

### Form set (Button, Input, Select, Checkbox), complete styled

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/ui + Tailwind CSS |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/ui + Tailwind CSS** | 0.1.4 | 63.2 kB | 55.4 kB | 197 kB | 69 kB | baseline |
| @mantine/core + styles.css | 7.17.4 | 75.2 kB | 63.8 kB | 437 kB | — | 1.2× larger [1.2–1.2] |
| @mui/material (Emotion) | 9.5.0 | 68.5 kB | 59.5 kB | 213 kB | — | 1.08× larger [1.08–1.08] |
| @radix-ui/themes + styles.css | 3.3.0 | 124 kB | 88 kB | 848 kB | — | 2.0× larger [2.0–2.0] |

**Notes**

- Styling is not equal, so there are two kinds of group. `JavaScript only` counts the components without styles; a rival that needs a stylesheet or styles itself at runtime is measured but never ranked (`differs`). `complete styled` adds the CSS a user must also ship, and ranks everything.
- @arki/ui is Base UI primitives styled with Tailwind classes. Its CSS comes from your app Tailwind build. In the `complete styled` groups it is a Tailwind v4 build of the classes found in the measured component files (found by Tailwind’s own scanner), with preflight and the workbench tokens and theme bridge. Fonts are left out. A real app adds the classes of its own code on top.
- Mantine and Radix Themes ship one stylesheet for the whole library (`styles.css`), not a per-component one, so their complete rows include the CSS of every component. MUI styles components at runtime with Emotion, so its JavaScript includes the styling engine and it has no stylesheet.
- Mantine `Modal` and MUI/Radix `Dialog` are the nearest equivalents of the @arki/ui Dialog parts.

Reproduce: `bunx arki-bench run --profile publish` in the package directory.

<!-- bench:meta {"schema":1,"suite":"@arki/ui","specHash":"90948ea457b5d678","profile":"publish","date":"2026-10-13T09:02:32.088Z","harness":"0.0.1"} -->
<!-- bench:end -->

## Related packages

- `@arki/design-systems`: tokens, Tailwind bridge and fonts for `atelier`, `workbench`, `arena`.
- `@arki/icons`: icon sets behind one React entry point.

## Documentation

- [docs/agent-guide.md](./docs/agent-guide.md): the model, a task map, the rules that bite, and how to verify.
- [llms.txt](./llms.txt): the short form for agents.

## Support

Report bugs and questions at <https://github.com/arki-labs/arki/issues>.

## License

MIT. See [LICENSE](./LICENSE).
