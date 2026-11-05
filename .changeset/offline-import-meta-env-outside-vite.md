---
'@arki/offline': patch
---

`@arki/offline/query` and `@arki/offline/devtools` now load outside Vite. `createPersistedQueryClient`
and `OfflineDevPanel` read `import.meta.env` only when it exists, so plain Node, Deno, a browser bundle
without Vite and an Expo app no longer throw a `TypeError`. There, the default `buster` is `''` and the
dev panel renders nothing. Inside Vite nothing changes.

- `./orpc` runs on Node, Bun, Deno and browsers, not Hermes (package.json `arki.entryRuntimes`): oRPC needs Web Streams (`TransformStream`), which React Native lacks. `./pwa` runs in browsers only: Workbox reads the worker global `self` when it loads.

no docs impact: the README runtime table and the `buster` doc comment are updated.
no demo impact: no demo runs these entries outside Vite.
