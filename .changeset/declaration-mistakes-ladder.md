---
'@arki/feature': minor
'@arki/http': minor
'@arki/db': patch
'@arki/dot': patch
---

Mistakes in declarations are now caught as early as possible: by TypeScript when the types can say it, otherwise by a coded error when the module loads.

- `@arki/feature`: `composeRouter` and `composeRepos` reject a key claimed by two features at compile time. The runtime check stays as a backstop and now throws `FeatureError` with code `FEATURE_E001` (router) or `FEATURE_E002` (repo) and a `remediation`. Messages are unchanged.
- `@arki/http`: mount paths for `rpcMount(...)` and `.mount(...)` are typed `MountPath` (`` `/${string}` ``), so a path without a leading `/` is a compile error. The runtime check stays.
- `@arki/db`: the projection builder's two "call .named() / .on() first" errors are now `DbCompositionError` with codes `DB_COMPOSITION_E002` and `DB_COMPOSITION_E003`. `DbCompositionError` gains an optional `remediation`.
- `@arki/dot`: when `dot explain` or `dot doctor` cannot import the app because a declaration threw a coded error, the output shows that error's code and its fix, not only "import failed".
