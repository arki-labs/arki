# @arki/icons

## 0.2.1

### Patch Changes

- 89d0ca0: Tidy two source lines so the package passes its own lint, with no change in behaviour.
- 933ac99: Ship compiled JavaScript. Every `exports` entry now points `import`, `browser` and `default` at `dist/src/*.js` (JSX compiled with the automatic `react/jsx-runtime`) instead of raw `src/*.ts(x)`, so Vite pre-bundles the package and Node or Vitest can load it without compiling `node_modules`. The spinner SVGs are copied next to `dist/src/spinners/index.js`, so `getSpinnerUrl()` still points at a real file. `@arki/icons/vite` is unchanged and its rewritten `@phosphor-icons/react/dist/...` paths still resolve. `./flags` imports `react-flagpack/dist/style.css`, so it still needs a bundler. Export names and the API are unchanged, so this is a patch.

  no docs impact: consumers import the same subpaths; only the files they resolve to changed.
  no demo impact: no demo imports a changed name.

- 0ce4f23: Each package README now records what it instruments, including why these packages need no spans.
- 2a9dea1: The `phosphorPerIcon` Vite plugin reads each module in one pass. Many `import {` with no `}` after them, or a long run of spaces in a specifier, made it read the rest of the module again from each one. It rewrites the same statements as before.

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
