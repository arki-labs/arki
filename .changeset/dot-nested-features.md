---
'@arki/dot': minor
---

Nested features and infra that receives the feature's needs.

- `.features(...children)` after `.infra()`: a child is named by its path (`digest.compile`), its provides are scoped (`digest.compile.ranker`) and private to the parent's scope, and the parent sees them by identity in `.needs()`. `allFeatures`, `ownUnits`, `mountFeatures` (assembly ownership check, `FEATURE_E005`), `override('compile.ranker')` by path, depth-aware `fake()`, and shutdown in reverse boot order.
- Infra plugins declare their needs unbound (`service<T>()`); `.infra()` binds each alias to a sibling's key first, then to the feature's own need of that alias. An infra need the feature does not declare, or binds to another handle, is a compile error and a runtime refusal.
- `entrypointOnly(handle)` in `.needs()`: entrypoints see it, usecases never do.
- Breaking: `.needs()` takes a record of aliases only (a bare handle is refused); feature services are published under one bag key, `<name>.services`, and `needsMiddleware` reads that key.
- `rpc()` mounts a declared child's router once, at the path the parent's contract gives it.
