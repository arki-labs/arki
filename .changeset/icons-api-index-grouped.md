---
'@arki/icons': patch
---

The published `dist/api.json` no longer lists one row per icon. The 22,000 same-type icon constants are one group row, and their names ship in `dist/api-names/`. The tarball is about 4 MB smaller; the exports themselves are unchanged.

no docs impact: only the machine-readable API index changes, no page or example does.
no demo impact: no export, behavior or type changes.
