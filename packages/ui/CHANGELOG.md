# @arki/ui

## 0.1.4

### Patch Changes

- Declare `class-variance-authority` and `debug` as dependencies. Both were imported but undeclared; inside the monorepo hoisting hid it, and the first external install (Drop Studio, clean clone) failed to resolve `class-variance-authority` from `button.tsx`.
- Updated dependencies [d06e5a7]
  - @arki/date@0.1.0

## 0.1.3

### Patch Changes

- Initial public release of Wave 4 — Frontend. Source-first packages: TypeScript source is the runtime entry, declarations ship in `dist/`, a bundler (Vite, TanStack Start, Next.js, Bun) is required.

  `@arki/design-systems` now ships the shared systems only (`atelier`, `workbench`, `arena`, `tribunal`, `gallery`); product-named systems moved out of the public package. `@arki/ui`, `@arki/icons` and `@arki/react-hooks` declare `react` as a peer dependency.

  Needed by the Drop Studio demo (`arki-labs/drop-studio`), the first external consumer of the storefront stack.

- Updated dependencies
  - @arki/theme@0.2.1
  - @arki/icons@0.1.1
  - @arki/react-hooks@0.1.1
  - @arki/design-systems@0.1.1

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/date@0.0.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/date@1.0.0
