---
'@arki/assert': patch
---

Faster checks. Results are unchanged.

- `isBase64` checks the length and one precompiled pattern itself instead of calling validator with a new options object each time (about 3× faster). A test checks it against validator on edge cases.
- `isURL` passes validator one options object built once, instead of a new object and array on every call.
