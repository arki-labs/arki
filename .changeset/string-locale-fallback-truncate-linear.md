---
'@arki/string': minor
---

A malformed locale tag (an `Accept-Language` header, a cookie) no longer throws. Case functions, `initials`, `fold`, `keywords`, `textMetrics`, the vocabulary functions and `StringValue.upper/lower` use locale-independent casing and log the swap at DEBUG (`arki:string:locale`). `truncate` with `boundary: 'word-before'` or `'sentence'` is linear on a long run of whitespace (it was quadratic: 200,000 spaces took minutes). `@arki/log` is a new dependency.
