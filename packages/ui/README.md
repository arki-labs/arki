# @arki/ui

React component library for ARKI apps: Base UI primitives styled with Tailwind v4 semantic tokens. Forms, overlays, navigation, data display, charts — one import per component.

> **Source-first package.** `@arki/ui` ships TypeScript source (`src/*.tsx`) as its runtime entry plus `.d.ts` declarations. Your bundler compiles it: Vite, TanStack Start, Next.js and Bun all do. Plain Node without a bundler is not supported.

## Installation

```sh
bun add @arki/ui @arki/design-systems @arki/theme react react-dom
```

Peer dependencies: `react` and `react-dom` 19.

## Setup

Components read semantic tokens (`--background`, `--primary`, `--muted`, …) from a design system. Pick one from `@arki/design-systems` and let Tailwind see the component classes:

```css
/* src/styles/global.css */
@import 'tailwindcss';
@import '@arki/design-systems/atelier/fonts.css';
@import '@arki/design-systems/atelier/tokens.css';
@import '@arki/design-systems/atelier/theme-bridge.css';

/* Tailwind must scan the component sources; adjust the path to where the package is installed. */
@source '../node_modules/@arki/ui/src';
```

## Usage

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

Every component is its own subpath (`@arki/ui/dialog`, `@arki/ui/select`, `@arki/ui/table`, `@arki/ui/chart`, …). See the `exports` map in `package.json` for the full list.

## Related packages

- `@arki/design-systems` — tokens, Tailwind bridge and fonts for `atelier`, `workbench`, `arena`.
- `@arki/theme` — light / dark / system provider and no-flash script.
- `@arki/icons` — icon sets behind one React entry point.
- `@arki/react-hooks` — the hooks the components use, reusable on their own.

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

## License

MIT
