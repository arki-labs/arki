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

<!-- bench:start -->
## Benchmarks

Bundle size of the same icons imported from @arki/icons and from popular React icon libraries. The main entry of @arki/icons is Phosphor, so Phosphor imported directly is a plain row to show the wrapper cost.

Measured on Node 22.13.1 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.0.1 (mitata 1.0.34) · publish, seed 1592639052 · commit 34146416b3 (uncommitted changes) · 2026-10-13.

Versions: @arki/bench 0.0.1 · @arki/icons 0.1.1 · @phosphor-icons/react 2.1.10 · lucide-react 0.542.0 · mitata 1.0.34 · react-icons 5.7.0.

### 1 icon

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/icons |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/icons** | 0.1.1 | 850 B | 752 B | 2.13 kB | 1 kB | baseline |
| @phosphor-icons/react (direct) | 2.1.10 | 853 B | 741 B | 2.13 kB | — | ≈ same |
| lucide-react | 0.542.0 | 746 B | 649 B | 1.25 kB | — | different contract: other drawings, one weight |
| react-icons (fa6) | 5.7.0 | 1.23 kB | 1.09 kB | 2.76 kB | — | different contract: other drawings, one weight |

### 10 common icons

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/icons |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/icons** | 0.1.1 | 7.01 kB | 5.94 kB | 29.1 kB | 8 kB | baseline |
| @phosphor-icons/react (direct) | 2.1.10 | 7.06 kB | 5.95 kB | 29.1 kB | — | ≈ same |
| lucide-react | 0.542.0 | 1.4 kB | 1.25 kB | 2.89 kB | — | different contract: other drawings, one weight |
| react-icons (fa6) | 5.7.0 | 2.73 kB | 2.33 kB | 7.08 kB | — | different contract: other drawings, one weight |

check, x, menu, search, user, settings, home, arrow-right, trash, plus.

**Notes**

- Only Phosphor draws the same icons as @arki/icons. Lucide and Font Awesome draw other shapes and ship one style per icon, so they are measured but never ranked (`differs`).
- Phosphor components carry all six weights (thin to duotone) in each icon, so they are larger per icon than single-weight libraries.
- react-icons is measured through its Font Awesome 6 set (`react-icons/fa6`), the set most guides show first.
- Sizes are minified, tree-shaken, with react left out, for the browser.

Reproduce: `bunx arki-bench run --profile publish` in the package directory.

<!-- bench:meta {"schema":1,"suite":"@arki/icons","specHash":"e7708cf7a5281c3b","profile":"publish","date":"2026-10-13T08:58:55.063Z","harness":"0.0.1"} -->
<!-- bench:end -->

## License

MIT. Icon sets keep their own licenses (Phosphor MIT, Iconify collections per set, Simple Icons CC0, flag-icons MIT).
