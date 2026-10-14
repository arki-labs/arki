# @arki/design-systems

## 0.1.2

### Patch Changes

- 15a99f5: Add `--success`, `--warning`, `--info` status colors and a `--destructive-surface` tint, each with a `-surface` tint, to atelier, workbench, arena and gallery (light and dark). Tribunal gains `--info`. All are mapped into Tailwind, so `bg-success`, `text-warning` and `bg-info-surface` work in every system.

## 0.1.1

### Patch Changes

- Initial public release of Wave 4 — Frontend. Source-first packages: TypeScript source is the runtime entry, declarations ship in `dist/`, a bundler (Vite, TanStack Start, Next.js, Bun) is required.

  `@arki/design-systems` now ships the shared systems only (`atelier`, `workbench`, `arena`, `tribunal`, `gallery`); product-named systems moved out of the public package. `@arki/ui`, `@arki/icons` and `@arki/react-hooks` declare `react` as a peer dependency.

  Needed by the Drop Studio demo (`arki-labs/drop-studio`), the first external consumer of the storefront stack.
