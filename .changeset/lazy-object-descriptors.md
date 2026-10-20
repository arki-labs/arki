---
'@arki/ts': patch
---

Fix lazy-object enumeration and spreads over frozen instances and nonconfigurable properties. Reflection exposes configurable views while writes and deletes continue to obey the original instance.
