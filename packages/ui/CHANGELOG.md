# @arki/ui

## 0.1.6

### Patch Changes

- d0ba607: Replaces the `"./*"` wildcard in `exports` with one explicit entry per public module. Every import path that worked before still works, so nothing breaks. New tools can now list and check the exact set of entries.
- 53ef944: Docs standard: README sections, AGENTS.md, llms.txt, agent guide and checked doc examples.

  Removes two `exports` entries that pointed at files that do not exist: `.` (`src/index.ts`) and `./toast` (`src/toast/index.ts`). Importing either already failed, so no working import changes. Use the per-component subpaths, for example `@arki/ui/button` and `@arki/ui/sonner`.

- Updated dependencies [a9a32c0]
- Updated dependencies [d0ba607]
- Updated dependencies [0f148f1]
- Updated dependencies [53ef944]
- Updated dependencies [8e0a3c0]
- Updated dependencies [53ef944]
- Updated dependencies [53ef944]
- Updated dependencies [d0ba607]
- Updated dependencies [53ef944]
  - @arki/react-hooks@0.1.2
  - @arki/icons@0.1.2
  - @arki/theme@0.2.2
  - @arki/design-systems@0.1.3

## 0.1.5

### Patch Changes

- 15a99f5: Callout uses the semantic `info`, `warning`, `success` and `destructive` surface and border colors, and the button focus ring uses `ring-ring`, so both follow the active design system.
- Updated dependencies [3c2cc9d]
- Updated dependencies [e115648]
- Updated dependencies [11f2ba7]
- Updated dependencies [15a99f5]
  - @arki/date@0.2.0
  - @arki/design-systems@0.1.2

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
