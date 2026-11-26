---
"@arki/journal": patch
---

Stop publishing test-only files: `src/fixtures/**` (the event-map sample app) and the two `test-support.ts` helpers. Only tests use them, and the build already leaves them out of `dist/`.

no docs impact: only the published file list in package.json changed.
no demo impact: no runtime file changed, only what the package ships.
