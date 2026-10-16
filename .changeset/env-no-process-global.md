---
'@arki/env': patch
---

`defineEnv` reads `globalThis.process?.env` instead of the bare `process` global, so it no longer throws a ReferenceError on engines without `process` (React Native Hermes, browsers). It still reads nothing at import. Pass `runtimeEnv` on those engines. Added the library lint preset and a cross-runtime smoke test.
