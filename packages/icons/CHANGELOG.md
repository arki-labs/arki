# @arki/icons

## 0.2.0

### Minor Changes

- cd41ee3: `@arki/icons/vite`: `phosphorPerIcon()` rewrites every named icon import from `@arki/icons/phosphor` or `@phosphor-icons/react` to the icon's own module at build time (`@phosphor-icons/react/dist/csr/<Icon>`), and `IconContext` to its context module. The app's imports stay as they are; the server stops loading the whole Phosphor index (about 300 ms at cold start) and loads only the icons it renders. `rewriteIconImports` and `phosphorIconNames` are exported for scripts.

### Patch Changes

- e6694fd: `@arki/icons/home` is a plain React SVG component. It no longer re-exports the `unplugin-icons` virtual module `~icons/twemoji/house`, so it builds in any bundler without that plugin. `HomeIcon` and `HouseIcon` keep their names and 1.2em size.
- b31c52d: The published `dist/api.json` no longer lists one row per icon. The 22,000 same-type icon constants are one group row, and their names ship in `dist/api-names/`. The tarball is about 4 MB smaller; the exports themselves are unchanged.

  no docs impact: only the machine-readable API index changes, no page or example does.
  no demo impact: no export, behavior or type changes.

- 5d55e12: Docs only: `llms.txt` import paths list `./vite`. No code change.

## 0.1.2

### Patch Changes

- d0ba607: Replaces the `"./*"` wildcard in `exports` with one explicit entry per public module. Every import path that worked before still works, so nothing breaks. New tools can now list and check the exact set of entries.
- 8e0a3c0: New `@arki/icons/spinners` entry: 110 animated SVG spinners (the old private `@arki/spinners` package). It exports `spinnerNames`, the `SpinnerName` type and `getSpinnerUrl(name)`, which returns the URL of the spinner's `.svg` file.
- 53ef944: Docs standard: README sections, AGENTS.md, llms.txt, agent guide and checked doc examples.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

## 0.1.1

### Patch Changes

- Initial public release of Wave 4 — Frontend. Source-first packages: TypeScript source is the runtime entry, declarations ship in `dist/`, a bundler (Vite, TanStack Start, Next.js, Bun) is required.

  `@arki/design-systems` now ships the shared systems only (`atelier`, `workbench`, `arena`, `tribunal`, `gallery`); product-named systems moved out of the public package. `@arki/ui`, `@arki/icons` and `@arki/react-hooks` declare `react` as a peer dependency.

  Needed by the Drop Studio demo (`arki-labs/drop-studio`), the first external consumer of the storefront stack.
