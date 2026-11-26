---
"@arki/clock": patch
"@arki/contracts": patch
"@arki/failure": patch
"@arki/schema": patch
"@arki/ts": patch
---

No code change. The changesets behind the previous patch gave their no-impact reasons in a form the release check could not read, so this patch carries them. That patch moved dependency pins (oRPC 1.16.5, TanStack Query 5.108.2) and stopped publishing type-test files.

no docs impact: no API or behaviour changed, only dependency pins and the published file list.
no demo impact: no runtime behaviour changed, demos take the same catalog.
