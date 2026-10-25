---
'@arki/tanstack-start': patch
---

`<DevTools />` now contains a failed load of its lazy panel. When the devtools chunk cannot be fetched (a proxy cut a large dependency short, a stale Vite optimize hash), it renders nothing and logs a warning on `arki:tanstack-start`. Before, the rejected `import()` reached the root route and the whole page stopped rendering.

no docs impact: behaviour fix, no API change.
no demo impact: dev-only component.
