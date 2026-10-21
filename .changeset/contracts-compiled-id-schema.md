---
'@arki/contracts': patch
---

`defineId(...)`: `create()` and `is()` parse with the id schema's `z.compile()` fast path, built once per declaration, and `is()` answers `false` for a non-string without parsing. Same results; about half the time per call, which matters for `requestId` on every HTTP request.
