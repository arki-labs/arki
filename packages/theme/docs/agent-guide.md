# @arki/theme for agents

Read this before changing theme code. The [README](../README.md) is the overview.

## The model

- `ThemeProvider` keeps one theme name in React state and in `localStorage`. It applies the resolved name (`light` or `dark`) to `<html>`.
- `system` is a theme name, not a result. The provider turns it into `light` or `dark` with `prefers-color-scheme`.
- `themeScript()` returns a string. Run it in `<head>` before React so the first paint already has the right class.

## Task map

### Add a theme to an app

```tsx
import type { ReactNode } from 'react';

import { ThemeProvider } from '@arki/theme';
import { themeScript } from '@arki/theme/script';

export function Shell({ children }: { children: ReactNode }) {
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
```

### Add a custom theme name

Pass the same list to the provider and the script.

```tsx
import type { ReactNode } from 'react';

import { ThemeProvider } from '@arki/theme';
import { themeScript } from '@arki/theme/script';

const themes = ['light', 'dark', 'sepia'];

export const sepiaScript = themeScript({ themes, defaultTheme: 'light' });

export function SepiaProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider themes={themes} defaultTheme="light">
      {children}
    </ThemeProvider>
  );
}
```

### Use a data attribute instead of a class

Use `attribute="data-theme"` on the provider and `attribute: 'data-theme'` in the script options. The `dark` class is still toggled so Tailwind `dark:` keeps working.

## Rules that bite

- `useTheme()` outside a provider returns `theme: undefined`. Do not treat that as an error.
- `setTheme` of a name that is not in `themes` stores `defaultTheme`.
- The script and the provider must get the same options, or the page flashes.
- The server always renders `defaultTheme`. Use `suppressHydrationWarning` on `<html>`.

## Errors

None. This package defines no error codes and throws nothing.

## Verify

```sh
bun run typecheck && bun run lint && bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
