---
'@arki/ui': minor
---

Adds the hooks from `@arki/react-hooks` as `@arki/ui/hooks/*`, one subpath per hook: `hooks/debounce`, `hooks/local-storage`, `hooks/media-query`, `hooks/hotkeys`, `hooks/copy-to-clipboard`, `hooks/timeout`, `hooks/toggle`, `hooks/pagination`, `hooks/async-memo`, `hooks/is-client`, `hooks/long-press`, `hooks/touch`, `hooks/use-viewport`, `hooks/use-swipe-gesture`, `hooks/use-touch-feedback`. The code is unchanged. `@arki/ui` no longer depends on `@arki/react-hooks`; that package is retired. To upgrade, replace `@arki/react-hooks/<name>` with `@arki/ui/hooks/<name>`.

demo impact: drop-studio's `arki.deps.json` lists `@arki/react-hooks` only as a transitive dependency of `@arki/ui` (no direct import); drop that entry on its next upgrade. faultline: none.
