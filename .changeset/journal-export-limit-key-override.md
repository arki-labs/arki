---
'@arki/journal': patch
---

`@arki/journal/pg` exports `LimitKeyOverride`, the type of the `journal_limits.keys` column. A schema module that infers its tables from `journalTables` can now name it, so its declaration no longer fails with TS2883.

no docs impact: a type export for an existing column, named by the compiler, not by app code.
no demo impact: no demo builds journal tables from inferred types.
