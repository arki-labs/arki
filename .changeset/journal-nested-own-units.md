---
'@arki/journal': minor
---

`journal()` reads each feature's projections from the feature's own units (`ownUnits`), so a nested child feature's `journalProjections` register once, under the child, instead of twice (once through the parent's `plugins()`).
