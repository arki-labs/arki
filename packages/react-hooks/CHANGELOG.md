# @arki/react-hooks

## 0.1.2

### Patch Changes

- a9a32c0: `@arki/react-hooks/media-query` no longer imports React itself: `useIsMobile`, `useIsTablet`, `useIsDesktop`, `useIsTabletOrDesktop` and `useIsTouchDevice` are now built on the re-exported @mantine/hooks `useMediaQuery` (same SSR-safe behaviour: the default value first, the real match after the first effect). A bundle that only takes `useMediaQuery` is now exactly the size of @mantine/hooks used directly (316 B gzip, was 328 B).
- d0ba607: Replaces the `"./*"` wildcard in `exports` with one explicit entry per public module. Every import path that worked before still works, so nothing breaks. New tools can now list and check the exact set of entries.
- 53ef944: Docs standard: README sections, AGENTS.md, llms.txt, agent guide and checked doc examples.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

## 0.1.1

### Patch Changes

- Initial public release of Wave 4 — Frontend. Source-first packages: TypeScript source is the runtime entry, declarations ship in `dist/`, a bundler (Vite, TanStack Start, Next.js, Bun) is required.

  `@arki/design-systems` now ships the shared systems only (`atelier`, `workbench`, `arena`, `tribunal`, `gallery`); product-named systems moved out of the public package. `@arki/ui`, `@arki/icons` and `@arki/react-hooks` declare `react` as a peer dependency.

  Needed by the Drop Studio demo (`arki-labs/drop-studio`), the first external consumer of the storefront stack.
