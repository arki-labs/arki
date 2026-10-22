---
'@arki/eslint-config': minor
---

`featureLayers()` knows the `domain-services/` folder. Files there follow the usecase import bans, may not import a sibling file or their own `feature.ts` at runtime, and another feature may not import them.
