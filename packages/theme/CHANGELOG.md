# @arki/theme

## 0.2.2

### Patch Changes

- 0f148f1: Apply the default theme when browser storage is blocked, and fall back to light when system theme detection is unavailable. Keep provider rendering and cleanup safe when media query APIs throw.
- 53ef944: Docs standard: README sections, AGENTS.md, llms.txt, agent guide and checked doc examples.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

## 0.2.1

### Patch Changes

- Initial public release of Wave 4 — Frontend. Source-first packages: TypeScript source is the runtime entry, declarations ship in `dist/`, a bundler (Vite, TanStack Start, Next.js, Bun) is required.

  `@arki/design-systems` now ships the shared systems only (`atelier`, `workbench`, `arena`, `tribunal`, `gallery`); product-named systems moved out of the public package. `@arki/ui`, `@arki/icons` and `@arki/react-hooks` declare `react` as a peer dependency.

  Needed by the Drop Studio demo (`arki-labs/drop-studio`), the first external consumer of the storefront stack.
