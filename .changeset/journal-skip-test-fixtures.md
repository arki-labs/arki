---
"@arki/journal": patch
---

Stop publishing test-only files: `src/fixtures/**` (the event-map sample app) and the two `test-support.ts` helpers. Only tests use them, and the build already leaves them out of `dist/`.

No docs impact: only the published file list changed. No demo impact: no runtime file changed.
