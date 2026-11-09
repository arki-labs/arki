---
"@arki/journal": patch
---

`checkEventMapFile` no longer throws a raw `RangeError` or runs out of memory on large files. The line diff skips the lines both texts share at the start and end, and when the rest is over 4,000,000 cells (about 2,000 × 2,000 lines) it returns one summary line as the `stale` diff instead.
