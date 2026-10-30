# @arki/ui

## 0.2.0

### Minor Changes

- 1511bbd: Adds the hooks from `@arki/react-hooks` as `@arki/ui/hooks/*`, one subpath per hook: `hooks/debounce`, `hooks/local-storage`, `hooks/media-query`, `hooks/hotkeys`, `hooks/copy-to-clipboard`, `hooks/timeout`, `hooks/toggle`, `hooks/pagination`, `hooks/async-memo`, `hooks/is-client`, `hooks/long-press`, `hooks/touch`, `hooks/use-viewport`, `hooks/use-swipe-gesture`, `hooks/use-touch-feedback`. The code is unchanged. `@arki/ui` no longer depends on `@arki/react-hooks`; that package is retired. To upgrade, replace `@arki/react-hooks/<name>` with `@arki/ui/hooks/<name>`.

  demo impact: drop-studio's `arki.deps.json` lists `@arki/react-hooks` only as a transitive dependency of `@arki/ui` (no direct import); drop that entry on its next upgrade. faultline: none.

- a225249: Breaking: `@arki/ui/design-system` is removed, and `@arki/ui` no longer depends on `@arki/design-systems`. The components read the standard shadcn token names, so any shadcn-compatible theme works; the README shows a minimal setup. Migrate: import design-system ids and helpers from the package that defines your themes instead.

  no demo impact: no demo imports `@arki/ui/design-system`.

- dd8839f: New `@arki/ui/styles/nav.css`: the page navigation crossfade (a view transition scoped to the `nav` type). It moved here from `@arki/design-systems/transitions/nav.css`. Migrate: change the `@import` path in your global stylesheet.

  no demo impact: no demo imports the navigation transition stylesheet.

- 74a447e: Adds the theme from `@arki/theme` as `@arki/ui/theme` (`ThemeProvider`, `useTheme`) and `@arki/ui/theme/script` (`themeScript`, `themeDetectionFn`, `THEME_STORAGE_KEY`). The code is unchanged, plus the unreleased `themeClasses` option: a theme can set several classes on the root element, and changing the theme removes them all. `@arki/ui` no longer depends on `@arki/theme`; that package is retired. To upgrade, replace `@arki/theme` with `@arki/ui/theme` and `@arki/theme/script` with `@arki/ui/theme/script`.

  demo impact: drop-studio's and faultline's `arki.deps.json` list `@arki/theme`; rename their imports and drop that entry on their next upgrade.

- ebc681b: `useAsyncMemo` now returns `{ value, isPending, failure, retry }` instead of the bare value. A rejected promise becomes `failure` instead of an unhandled rejection, and `retry()` runs the factory again. `useViewport` returns the server desktop default on the first client render and reads the real window after mount, so a phone no longer hydrates different markup. `DatePicker` shows the placeholder for an invalid `Date`. `useFormField` names `<Form>` or `<FormField>` as the missing parent (the field context default is now `null`). Touch-feedback errors log through `@arki/log` at debug (`arki:ui:touch`). New subpath `@arki/ui/copy-text` (`copyText`, moved from `@arki/chat-ui` so `Pre` and `CodeBlock` share one clipboard helper). Chart tooltip and legend items are typed, no `any`.

### Patch Changes

- fb2103b: Fix runtime failures that plain input could trigger.

  - `@arki/string`: `words`, `wordCount` and every count built on them scan text in linear steps. One regex with a repeating group overflowed the engine's stack on Node for megabytes of text such as `a-a-a-`. Results on ordinary text are unchanged.
  - `@arki/chat-ui`: the `CodeBlock` copy button awaits the clipboard write. A refused write shows "Copy failed" for 2 seconds instead of an unhandled rejection.
  - `@arki/content-react`: a markdown image with no alt text renders as a decorative image (`alt=""`) instead of throwing during render, and an image with no source renders nothing. The code-block copy button shows a failed state when the clipboard is refused or missing. `useSearch` adds `isError` and `retry()`.
  - `@arki/ui`: the sidebar logs through `@arki/log` instead of `debug`, so importing it no longer reads `process.env.DEBUG` (Deno without env permission threw at import). Its debug output now follows the app's `@arki/log` configuration. A refused cookie write no longer throws; the sidebar just does not remember its state.

- fcc97e9: `ThemeProvider` now shows a stored theme after hydration. Its first render read `localStorage` in the browser but not on the server, and React keeps mismatched attributes during hydration, so a theme switcher stayed on the server's default (for example "Auto" while Lamplight was active). The provider now renders the default on both sides, reads the stored theme and the OS preference in a layout effect before the first paint, and leaves the pre-paint script's classes alone until then. No docs impact: behaviour now matches what the theme docs already describe. No demo impact: no demo covers theme hydration.
- ff85471: Go to Definition works on mapped keys again. Handle maps (`unit.provides.x`, feature handles), `PolicyTree`, `SessionValues`, `CronPolicy.respond`, `ChartConfig.theme`, `Operations` and the oRPC utils tree now map `[K in keyof T as K & string]` instead of `[K in keyof T & string]`. The old form cut the link from each key back to its declaration, so the editor found no definition. Types are otherwise unchanged.
- Updated dependencies [b31c52d]
- Updated dependencies [cd41ee3]
- Updated dependencies [5d55e12]
  - @arki/icons@0.2.0

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
