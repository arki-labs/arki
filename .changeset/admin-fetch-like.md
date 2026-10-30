---
'@arki/admin': patch
---

The `fetch` option of `createForemanClient` and `fetchFleetSnapshot` now takes a plain `(url, init) => Promise<Response>` instead of `typeof fetch`. Where Bun's types are loaded, even through a dependency, `typeof fetch` also requires `fetch.preconnect`, so a wrapper around fetch did not compile. The global `fetch` still fits. No docs impact: the option is not documented beyond its JSDoc. No demo impact: no demo overrides fetch.
