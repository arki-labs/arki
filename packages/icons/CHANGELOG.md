# @arki/icons

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
