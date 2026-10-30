---
'@arki/lock': patch
---

`pgLease(...).dispose()` now returns a `lock.store` failure (method `dispose`) when the LISTEN connection cannot be released. Before, the error was swallowed and `dispose` resolved as if it had worked. No docs impact. No demo impact.
