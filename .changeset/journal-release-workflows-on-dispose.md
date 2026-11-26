---
"@arki/journal": patch
---

A dev server boots again after a backend edit. The Dot journal unit now frees its workflows when its app is disposed, so the next app on the same cached `initJournal()` composes them again. Before, every re-boot failed with `BAD_DEFINITION: this initJournal() already composed a journal with workflows` until the dev server restarted. Two live apps on one `initJournal()` are still refused. A `compose({ workflows })` that throws part-way now registers nothing, so a corrected compose works.

no demo impact: no demo re-boots an app.
