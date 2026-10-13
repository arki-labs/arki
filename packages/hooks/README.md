# @arki/react-hooks

Curated React hooks for ARKI apps. Thin, typed wrappers over Mantine hooks, usehooks-ts, react-hotkeys-hook and friends, so an app imports one package and gets one consistent API.

> **Source-first package.** Ships TypeScript source as the runtime entry plus `.d.ts`. Your bundler (Vite, TanStack Start, Next.js, Bun) compiles it.

## Installation

```sh
bun add @arki/react-hooks react
```

Peer dependency: `react` 19.

## Usage

One hook per subpath:

```tsx
import { useDebounce } from '@arki/react-hooks/debounce';
import { useLocalStorage } from '@arki/react-hooks/local-storage';
import { useMediaQuery } from '@arki/react-hooks/media-query';
```

Available subpaths: `async-memo`, `copy-to-clipboard`, `debounce`, `hotkeys`, `is-client`, `local-storage`, `long-press`, `media-query`, `pagination`, `timeout`, `toggle`, `touch`, `use-swipe-gesture`, `use-touch-feedback`, `use-viewport`.

## License

MIT
