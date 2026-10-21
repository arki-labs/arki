---
'@arki/log': minor
---

`maskSecrets(values)` processor: replaces every occurrence of a known secret value (8+ characters) in the template, string fields at any depth, the serialised error and the body. Pairs with `secretValues` from `@arki/env/node`: `processors: [maskSecrets(secretValues)]`. Also exports `MIN_SECRET_LENGTH`.
