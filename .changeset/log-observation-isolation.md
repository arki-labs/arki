---
'@arki/log': patch
---

Contain context, trace, sink lifecycle and deferred descriptor faults so logging preserves application outcomes. Observe asynchronous rejections, clean up every sink independently, and keep reentrant deduplication records for the next flush.
