---
'@arki/icons': patch
---

Replaces the `"./*"` wildcard in `exports` with one explicit entry per public module. Every import path that worked before still works, so nothing breaks. New tools can now list and check the exact set of entries.
