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

## License

MIT
