# @arki/icons

Icon sets for ARKI apps behind one React entry point: Phosphor by default, plus Iconify, Simple Icons brand marks and flag packs.

> **Source-first package.** Ships TypeScript source as the runtime entry plus `.d.ts`. Your bundler (Vite, TanStack Start, Next.js, Bun) compiles it.

## Installation

```sh
bun add @arki/icons react
```

Peer dependency: `react` 19. Note the install footprint: this package depends on `@iconify/json` (the full Iconify dataset) so any icon set can be used without a second install.

## Usage

```tsx
import { MagnifyingGlass } from '@arki/icons'; // Phosphor, same as '@arki/icons/phosphor'
import { Flag } from '@arki/icons/flags';
import { BrandIcon } from '@arki/icons/brands';
```

Subpaths:

| Import | What it is |
| --- | --- |
| `@arki/icons` | Phosphor icons (re-export of `./phosphor`) and shared icon types |
| `@arki/icons/phosphor` | Phosphor React components |
| `@arki/icons/phosphor/ssr` | Phosphor SSR-safe entry |
| `@arki/icons/phosphor/defaults` | Default size / weight context |
| `@arki/icons/flags` | Country flags |
| `@arki/icons/brands` | Brand marks (Simple Icons) |

Every other file under `src/` is reachable as `@arki/icons/<file>` too. One of them, `@arki/icons/home`, uses an `unplugin-icons` virtual import (`~icons/...`) and only works in a bundler configured with that plugin.

## License

MIT. Icon sets keep their own licenses (Phosphor MIT, Iconify collections per set, Simple Icons CC0, flag-icons MIT).
