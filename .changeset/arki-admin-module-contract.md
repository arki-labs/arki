---
'@arki/admin': minor
---

New `@arki/admin/module` entry: the isomorphic Foreman module contract. `defineRead`, `defineAction` (preview with a `revision`, execute under a `Permit`), `defineSignal` and `defineModule` describe what operators may see and do once; `describeModule` turns a module into JSON Schemas with a `schemaHash` per read, action and signal (Web Crypto, every runtime); `toDotAction()` puts each capability in the DOT manifest with `binding: 'foreman'`. Failures are `AdminError`s with stable `ARKI_ADMIN_E00x` codes. The package now uses the library lint preset; `./server` stays the Node-only adapter.
