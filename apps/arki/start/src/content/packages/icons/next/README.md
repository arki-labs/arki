# @arki/icons

Icon sets for ARKI apps behind one React entry point: Phosphor by default, plus Iconify, Simple Icons brand marks and country flags.

## Install

```sh
bun add @arki/icons react
```

`react` 19 is a peer dependency. This package depends on `@iconify/json` (the full Iconify dataset) so any Iconify set works without a second install. Expect a larger `node_modules`.

## Quick start

```tsx
import { MagnifyingGlass } from '@arki/icons';
import { AtelierIconDefaults } from '@arki/icons/phosphor/defaults';

export function SearchButton() {
  return (
    <AtelierIconDefaults>
      <button aria-label="Search">
        <MagnifyingGlass />
      </button>
    </AtelierIconDefaults>
  );
}
```

`@arki/icons` is Phosphor. `AtelierIconDefaults` sets the size, colour and weight for every Phosphor icon below it. Use `WorkbenchIconDefaults` for the workbench system. Without a provider, Phosphor uses its own defaults.

## When not to use this

- You want one icon from one set. Import `@phosphor-icons/react` or `lucide-react` directly. This package adds the defaults providers and the other sets, not new icons.
- You need the smallest possible bundle. One Phosphor icon costs about the same as the direct import, but the Iconify data in `node_modules` is large.
- Your bundler cannot handle `.tsx` source or CSS imports. See Runtime support.

## Runtime support

Source-distributed: ships TypeScript/TSX, needs a bundler (Vite with the TanStack Start stack).

## Public imports

| Import | What it is |
| --- | --- |
| `@arki/icons` | Phosphor icons (same as `./phosphor`) and the `IconSVG` type |
| `@arki/icons/phosphor` | Phosphor React components and `IconContext` |
| `@arki/icons/phosphor/ssr` | Phosphor static variant, for server components |
| `@arki/icons/phosphor/defaults` | Default size, colour and weight providers per design system |
| `@arki/icons/flags` | `Flag`, country flags from a two-letter code |
| `@arki/icons/brands` | Brand marks from Simple Icons, such as `siGithub` |
| `@arki/icons/wc` | Iconify icons by name, loaded as a web component |
| `@arki/icons/spinners` | Names of the animated SVG spinners |
| `@arki/icons/types` | `IconSVG` |
| `@arki/icons/home` | A Twemoji house, built by `unplugin-icons` |

## Failure behaviour

Nothing here throws at runtime. Mistakes show up as types or as a missing picture.

- A wrong Phosphor name is a type error at build time.
- `Flag` takes a `code` typed from `flagpack-core`. A code that slips past the types renders a broken `<img>`. The component does not check that the file exists.
- A brand mark is plain data (`title`, `hex`, `path`, `svg`). Importing a name that Simple Icons removed is a build error.
- `Icon` from `@arki/icons/wc` shows nothing until its data is loaded. Handle the empty state yourself.

## Limits

- `Flag` loads `/flags/<size>/<code>.svg` from your own server. Copy the `flagpack-core` SVGs into `public/flags/` or the picture is broken. The package does not copy them.
- `@arki/icons/home` imports `~icons/twemoji/house`, a virtual module from `unplugin-icons`. It fails to build unless the plugin is in your bundler config. Do not import it otherwise.
- `Icon` from `@arki/icons/wc` fetches icons you did not register with `addIcon` from the Iconify API, over the network. Register the icons you need if the page must work offline.
- Phosphor icons read `IconContext`, so they re-render when the provider value changes. In a server component or a long list, import `@arki/icons/phosphor/ssr` instead. Boundary: an `ssr` icon ignores `AtelierIconDefaults` and uses Phosphor's own size and weight.

```tsx
import { MagnifyingGlass } from '@arki/icons/phosphor/ssr';
import { siGithub } from '@arki/icons/brands';

export function Links() {
  return (
    <nav>
      <MagnifyingGlass size={16} />
      <svg viewBox="0 0 24 24" width={16} height={16} fill={`#${siGithub.hex}`}>
        <path d={siGithub.path} />
      </svg>
    </nav>
  );
}
```

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

## Documentation

- [docs/agent-guide.md](./docs/agent-guide.md): the model, a task map, the rules that bite, and how to verify.
- [llms.txt](./llms.txt): the short form for agents.

## Support

Report bugs and questions at <https://github.com/arki-labs/arki/issues>.

## License

MIT. See [LICENSE](./LICENSE). Icon sets keep their own licenses (Phosphor MIT, Iconify collections per set, Simple Icons CC0, flag-icons MIT).
