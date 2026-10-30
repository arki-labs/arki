# @arki/icons for agents

Read this before adding an icon or a provider. The [README](../README.md) is the overview.

## The model

- The root import is Phosphor. Other sets sit on subpaths: `flags`, `brands`, `wc`, `spinners`.
- A Phosphor icon reads `IconContext` for its size, colour and weight. A defaults provider from `@arki/icons/phosphor/defaults` fills that context for one design system.
- The `phosphor/ssr` variant skips the context. It is cheaper and ignores providers.

## Task map

### Show a Phosphor icon

```tsx
import { House } from '@arki/icons';

export function HomeLink() {
  return (
    <a href="/">
      <House weight="bold" />
    </a>
  );
}
```

### Set icon defaults for a design system

Mount one provider near the root. Use the one that matches the app's design system. Never mix systems in one app.

```tsx
import type { ReactNode } from 'react';

import { WorkbenchIconDefaults } from '@arki/icons/phosphor/defaults';

export function Root({ children }: { children: ReactNode }) {
  return <WorkbenchIconDefaults>{children}</WorkbenchIconDefaults>;
}
```

### Change the weight in one region

`PhosphorIconScope` keeps the parent's size and colour and changes only what you pass.

```tsx
import type { ReactNode } from 'react';

import { PhosphorIconScope } from '@arki/icons/phosphor/defaults';

export function Footer({ children }: { children: ReactNode }) {
  return <PhosphorIconScope overrides={{ weight: 'regular' }}>{children}</PhosphorIconScope>;
}
```

### Show a country flag

Serve the SVGs at `/flags/<size>/<code>.svg` first.

```tsx
import { Flag } from '@arki/icons/flags';

export function Romania() {
  return <Flag code="RO" size="m" />;
}
```

### Add a new icon set

Add a subpath with its own entry file and a one-line summary comment. Add the `exports` row and the README row. Run `bun ../../tooling/library/src/llms.ts --write`.

## Rules that bite

- `Flag` does not ship the SVG files.
- `phosphor/ssr` icons ignore `IconContext`.
- The wc `Icon` fetches unregistered icons over the network.

## Errors

None. This package defines no error codes and throws nothing of its own.

## Verify

```sh
bun run typecheck && bun run lint && bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
