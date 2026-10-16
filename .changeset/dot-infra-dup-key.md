---
'@arki/dot': patch
---

`.infra()` refuses two plugins that provide the same service key at compile time (`DOT: two infra plugins provide the same key`, naming the key). The runtime already threw `ARKI_DOT_E027` for the pair; the types used to intersect the two records silently.
