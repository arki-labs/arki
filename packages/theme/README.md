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

## License

MIT
